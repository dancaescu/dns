/**************************************************************************************************
	$Id: axfr.c,v 1.39 2005/05/06 16:06:18 bboy Exp $

	Copyright (C) 2002-2005  Don Moore <bboy@bboy.net>

	This program is free software; you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation; either version 2 of the License, or
	(at Your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.

	You should have received a copy of the GNU General Public License
	along with this program; if not, write to the Free Software
	Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
**************************************************************************************************/

#include "named.h"
#include "../lib/tsig.h"
#include "../lib/dnsupdate.h"

/* Make this nonzero to enable debugging for this source file */
#define	DEBUG_AXFR	1


#define	AXFR_TIME_LIMIT		3600		/* AXFR may not take more than this long, overall */

static size_t total_records, total_octets;

/* TSIG state for multi-packet signing */
static tsig_key_t *axfr_tsig_key = NULL;
static unsigned char axfr_request_mac[64];
static size_t axfr_request_mac_len = 0;
static unsigned char axfr_prev_mac[64];
static size_t axfr_prev_mac_len = 0;
static int axfr_packet_count = 0;


/**************************************************************************************************
	AXFR_ERROR
	Quits and outputs a warning message.
**************************************************************************************************/
/* Stupid compiler doesn't know exit from _exit... */
/* static void axfr_error(TASK *, const char *, ...) __attribute__ ((__noreturn__)); */
static void
axfr_error(TASK *t, const char *fmt, ...) {
  va_list	ap; 
  char		*msg = NULL;

  if (t) {
    task_output_info(t, NULL);
  } else {
    va_start(ap, fmt);
    VASPRINTF(&msg, fmt, ap);
    va_end(ap);

    Warnx("%s", msg);
    RELEASE(msg);
  }

  sockclose(t->fd);

  _exit(EXIT_FAILURE);
  /* NOTREACHED */
}
/*--- axfr_error() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_TIMEOUT
	Hard timeout called by SIGALRM after one hour.
**************************************************************************************************/
static void
axfr_timeout(int dummy) {
  axfr_error(NULL, _("AXFR timed out"));
}
/*--- axfr_timeout() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_WRITE_WAIT
	Wait for the client to become ready to read.  Times out after `task_timeout' seconds.
**************************************************************************************************/
static void
axfr_write_wait(TASK *t) {
  int			rv = 0;
  struct pollfd item;
  item.fd = t->fd;
  item.events = POLLOUT;
  item.revents = 0;

#if HAVE_POLL
  rv = poll(&item, 1, -1);
  if (rv >= 0) {
    if (rv != 1 || !(item.revents & POLLOUT) || (item.revents & (POLLERR|POLLHUP|POLLNVAL)))
      axfr_error(t, _("axfr_write_wait write timeout failure"));
  }
#else
#if HAVE_SELECT
  fd_set		wfd;
  fd_set		efd
  struct timeval 	tv = { 0, 0 };

  FD_ZERO(&wfd);
  FD_SET(t->fd, &wfd);
  FD_ZERO(&efd);
  FD_SET(t->fd, &efd);
  tv.tv_sec = task_timeout;
  tv.tv_usec = 0;
  rv = select(t->fd + 1, NULL, &wfd, &efd, &tv);
  if (rv >= 0) {
    if (rv != 1 || !FD_ISSET(t->fd, &wfd) || FD_ISSET(t->fd, &efd))
      axfr_error(t, _("axfr_write_waut write timeout failure"));
  }
#else
#error You must have either poll(preferred) or select to compile this code
#endif
#endif
  if (rv < 0)
    axfr_error(t, "axfr_write_wait poll failed %s(%d)", strerror(errno), errno);
}
/*--- axfr_write_wait() -------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_WRITE
	Writes the specified buffer, obeying task_timeout (via axfr_write_wait).
**************************************************************************************************/
static void
axfr_write(TASK *t, char *buf, size_t size) {
  int		rv = 0;
  size_t	offset = 0;

  do {
    axfr_write_wait(t);
    if ((rv = write(t->fd, buf+offset, size-offset)) < 0)
      axfr_error(t, _("write: %s"), strerror(errno));
    if (!rv)
      axfr_error(t, _("client closed connection"));
    offset += rv;
  } while (offset < size);
}
/*--- axfr_write() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	EXTRACT_TSIG_MAC
	Extract MAC from signed response for chaining to next packet.
**************************************************************************************************/
static int
extract_tsig_mac(const unsigned char *message, size_t message_len,
                unsigned char *mac_out, size_t *mac_len_out) {
  /* TSIG is always the last record in Additional section */
  if (message_len < 12) return -1;

  uint16_t qdcount = (message[4] << 8) | message[5];
  uint16_t ancount = (message[6] << 8) | message[7];
  uint16_t nscount = (message[8] << 8) | message[9];
  uint16_t arcount = (message[10] << 8) | message[11];

  if (arcount == 0) return -1;

  size_t offset = 12;
  int i;

  /* Skip Question section */
  for (i = 0; i < qdcount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    offset += 4;  /* Skip TYPE + CLASS */
  }

  /* Skip Answer section */
  for (i = 0; i < ancount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    if (offset + 10 > message_len) return -1;
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10 + rdlength;
  }

  /* Skip Authority section */
  for (i = 0; i < nscount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    if (offset + 10 > message_len) return -1;
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10 + rdlength;
  }

  /* Find TSIG record in Additional section (should be last) */
  for (i = 0; i < arcount && offset < message_len; i++) {
    size_t record_start = offset;

    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }

    if (offset + 10 > message_len) return -1;

    uint16_t rtype = (message[offset] << 8) | message[offset + 1];
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10;

    /* Check if this is TSIG record (type 250) */
    if (rtype == 250 && i == arcount - 1) {
      /* This is the TSIG record - parse RDATA to find MAC */
      size_t rdata_start = offset;

      /* Skip Algorithm Name */
      while (offset < message_len && message[offset] != 0) {
        if ((message[offset] & 0xC0) == 0xC0) {
          offset += 2;
          break;
        }
        offset += message[offset] + 1;
      }
      if (message[offset] == 0) offset++;

      /* Skip Time Signed (6 bytes) + Fudge (2 bytes) */
      offset += 8;

      if (offset + 2 > message_len) return -1;

      /* Read MAC Size */
      uint16_t mac_size = (message[offset] << 8) | message[offset + 1];
      offset += 2;

      if (mac_size > 64 || offset + mac_size > message_len) return -1;

      /* Extract MAC */
      memcpy(mac_out, message + offset, mac_size);
      *mac_len_out = mac_size;
      return 0;
    }

    /* Not TSIG, skip to next record */
    offset = record_start;
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    if (offset + 10 > message_len) return -1;
    rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10 + rdlength;
  }

  return -1;
}
/*--- extract_tsig_mac() ------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_REPLY
	Sends one reply to the client.
**************************************************************************************************/
static void
axfr_reply(TASK *t) {
  char len[2] = { 0, 0 }, *l = len;
  char *reply_to_send = NULL;
  size_t reply_len_to_send = 0;

  build_reply(t, 0);

  /* Sign with TSIG if key is present */
  if (axfr_tsig_key) {
    size_t max_tsig_len = 200;
    char *signed_reply = ALLOCATE(t->replylen + max_tsig_len, char[]);
    size_t new_len = 0;
    unsigned char *mac_to_use = NULL;
    size_t mac_len_to_use = 0;

    if (!signed_reply) {
      Warnx(_("Failed to allocate buffer for TSIG signing"));
      goto send_unsigned;
    }

    memcpy(signed_reply, t->reply, t->replylen);

    /* Determine which MAC to use */
    if (axfr_packet_count == 0) {
      /* First packet: use request MAC */
      mac_to_use = axfr_request_mac;
      mac_len_to_use = axfr_request_mac_len;
    } else {
      /* Subsequent packets: use previous response MAC */
      mac_to_use = axfr_prev_mac;
      mac_len_to_use = axfr_prev_mac_len;
    }

    /* Sign the packet */
    if (tsig_sign((unsigned char*)signed_reply, t->replylen, t->replylen + max_tsig_len,
                  axfr_tsig_key, mac_to_use, mac_len_to_use, &new_len) == 0) {

      /* Extract MAC from this signed packet for next packet */
      if (extract_tsig_mac((unsigned char*)signed_reply, new_len,
                          axfr_prev_mac, &axfr_prev_mac_len) < 0) {
        /* Failed to extract MAC - continue anyway */
        Warnx(_("Failed to extract MAC from AXFR packet %d"), axfr_packet_count);
        axfr_prev_mac_len = 0;
      }

      reply_to_send = signed_reply;
      reply_len_to_send = new_len;
      axfr_packet_count++;

#if DEBUG_ENABLED && DEBUG_AXFR
      DebugX("axfr", 1, _("AXFR packet %d signed with TSIG (%zu -> %zu bytes)"),
             axfr_packet_count, t->replylen, new_len);
#endif
    } else {
      /* Signing failed - send unsigned */
      Warnx(_("TSIG signing failed for AXFR packet %d"), axfr_packet_count);
      RELEASE(signed_reply);
      goto send_unsigned;
    }
  } else {
send_unsigned:
    reply_to_send = t->reply;
    reply_len_to_send = t->replylen;
  }

  /* Send the packet */
  l = len;
  DNS_PUT16(l, reply_len_to_send);
  axfr_write(t, len, SIZE16);
  axfr_write(t, reply_to_send, reply_len_to_send);
  total_octets += SIZE16 + reply_len_to_send;
  total_records++;

  /* Free signed reply buffer if allocated */
  if (reply_to_send != t->reply) {
    RELEASE(reply_to_send);
  }

  /* Reset the pertinent parts of the task reply data */
  rrlist_free(&t->an);
  rrlist_free(&t->ns);
  rrlist_free(&t->ar);

  RELEASE(t->reply);
  t->replylen = 0;

  name_forget(t);

  RELEASE(t->rdata);
  t->rdlen = 0;

  /* Nuke question data */
  t->qdcount = 0;
  t->qdlen = 0;
}
/*--- axfr_reply() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	CHECK_XFER
	If the "xfer" column exists in the soa table, it should contain a list of wildcards separated
	by commas.  In order for this zone transfer to continue, one of the wildcards must match
	the client's IP address.
**************************************************************************************************/
static void
check_xfer(TASK *t, MYDNS_SOA *soa) {
  SQL_RES	*res = NULL;
  SQL_ROW	row = NULL;
  char		ip[256];
  char		*query = NULL;
  size_t	querylen = 0;
  int		ok = 0;

  memset(&ip, 0, sizeof(ip));

  if (!mydns_soa_use_xfer)
    return;

  strncpy(ip, clientaddr(t), sizeof(ip)-1);

  querylen = sql_build_query(&query, "SELECT xfer FROM %s WHERE id=%u%s%s%s;",
			     mydns_soa_table_name, soa->id,
			     (mydns_rr_use_active)? " AND active='" : "",
			     (mydns_rr_use_active)? mydns_rr_active_types[0] : "",
			     (mydns_rr_use_active)? "'" : "");

  res = sql_query(sql, query, querylen);
  RELEASE(query);
  if (!res) {
    ErrSQL(sql, "%s: %s", desctask(t), _("error loading zone transfer access rules"));
  }

  if ((row = sql_getrow(res, NULL))) {
    char *wild = NULL, *r = NULL;

    for (r = row[0]; !ok && (wild = strsep(&r, ",")); )	{
      if (strchr(wild, '/')) {
	if (t->family == AF_INET)
	  ok = in_cidr(wild, t->addr4.sin_addr);
      }	else if (wildcard_match(wild, ip))
	ok = 1;
    }
  }
  sql_free(res);

  if (!ok) {
    dnserror(t, DNS_RCODE_REFUSED, ERR_NO_AXFR);
    axfr_reply(t);
    axfr_error(t, _("access denied"));
  }
}
/*--- check_xfer() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	PARSE_TSIG_FOR_AXFR
	Parse TSIG record from AXFR request Additional section.
**************************************************************************************************/
static int
parse_tsig_for_axfr(TASK *t, char *key_name, size_t key_name_size,
                    unsigned char *mac, size_t *mac_len,
                    uint64_t *time_signed, uint16_t *fudge) {
  const unsigned char *message = (const unsigned char *)t->query;
  size_t message_len = t->len;
  size_t offset = 12;  /* Start after DNS header */
  int i;

  if (!t->arcount || t->arcount == 0) {
    return -1;  /* No Additional records */
  }

  /* Skip Question section */
  for (i = 0; i < t->qdcount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    offset += 4;  /* Skip QTYPE + QCLASS */
  }

  /* Skip Answer section */
  for (i = 0; i < t->ancount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    if (offset + 10 > message_len) return -1;
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10 + rdlength;
  }

  /* Skip Authority section */
  for (i = 0; i < t->nscount && offset < message_len; i++) {
    /* Skip NAME */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    if (offset + 10 > message_len) return -1;
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10 + rdlength;
  }

  /* Parse Additional section - TSIG should be last record */
  for (i = 0; i < t->arcount && offset < message_len; i++) {
    size_t name_start = offset;
    size_t name_len = 0;

    /* Parse NAME and store for TSIG key name */
    while (offset < message_len) {
      if (message[offset] == 0) {
        offset++;
        break;
      }
      if ((message[offset] & 0xC0) == 0xC0) {
        offset += 2;
        break;
      }
      offset += message[offset] + 1;
    }
    name_len = offset - name_start;

    if (offset + 10 > message_len) return -1;

    uint16_t rtype = (message[offset] << 8) | message[offset + 1];
    uint16_t rclass = (message[offset + 2] << 8) | message[offset + 3];
    uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
    offset += 10;

    /* Check if this is a TSIG record (type 250, class ANY=255) */
    if (rtype == 250 && rclass == 255) {
      /* Extract key name */
      size_t key_offset = 0;
      size_t name_offset = name_start;
      while (name_offset < name_start + name_len && key_offset < key_name_size - 1) {
        if (message[name_offset] == 0) break;
        if ((message[name_offset] & 0xC0) == 0xC0) break;

        uint8_t label_len = message[name_offset++];
        if (label_len > 0 && label_len <= 63) {
          if (key_offset > 0 && key_offset < key_name_size - 1) {
            key_name[key_offset++] = '.';
          }
          size_t copy_len = (label_len < (key_name_size - key_offset - 1)) ?
                           label_len : (key_name_size - key_offset - 1);
          memcpy(key_name + key_offset, message + name_offset, copy_len);
          key_offset += copy_len;
          name_offset += label_len;
        }
      }
      key_name[key_offset] = '\0';

      /* Parse TSIG RDATA */
      size_t rdata_start = offset;

      /* Skip algorithm name */
      while (offset < message_len && message[offset] != 0) {
        if ((message[offset] & 0xC0) == 0xC0) {
          offset += 2;
          break;
        }
        offset += message[offset] + 1;
      }
      if (offset < message_len && message[offset] == 0) offset++;

      if (offset + 10 > message_len) return -1;

      /* Parse time signed (48-bit) */
      *time_signed = 0;
      for (int j = 0; j < 6; j++) {
        *time_signed = (*time_signed << 8) | message[offset++];
      }

      /* Parse fudge (16-bit) */
      *fudge = (message[offset] << 8) | message[offset + 1];
      offset += 2;

      /* Parse MAC size (16-bit) */
      uint16_t mac_size = (message[offset] << 8) | message[offset + 1];
      offset += 2;

      /* Parse MAC */
      if (mac_size > 64) mac_size = 64;
      if (offset + mac_size > message_len) return -1;
      memcpy(mac, message + offset, mac_size);
      *mac_len = mac_size;

      return 0;  /* Success */
    }

    offset += rdlength;
  }

  return -1;  /* No TSIG found */
}
/*--- parse_tsig_for_axfr() ---------------------------------------------------------------------*/


/**************************************************************************************************
	LOAD_TSIG_KEY_FOR_ZONE
	Load TSIG key from database by name.
**************************************************************************************************/
static tsig_key_t *
load_tsig_key_for_zone(TASK *t, const char *key_name) {
  SQL_RES *res = NULL;
  SQL_ROW row = NULL;
  char *query = NULL;
  size_t querylen = 0;
  tsig_key_t *key = NULL;

  if (!key_name || !strlen(key_name))
    return NULL;

  /* Query tsig_keys table */
  querylen = sql_build_query(&query,
    "SELECT name, algorithm, secret FROM tsig_keys WHERE name='%s' AND enabled=TRUE",
    key_name);

#if DEBUG_ENABLED && DEBUG_AXFR
  DebugX("axfr", 1, _("%s: TSIG KEY LOOKUP: %s"), desctask(t), query);
#endif

  res = sql_query(sql, query, querylen);
  RELEASE(query);

  if (!res) {
    WarnSQL(sql, "%s: %s", desctask(t), _("error loading TSIG key"));
    return NULL;
  }

  if ((row = sql_getrow(res, NULL))) {
    /* Create TSIG key from database row */
    key = tsig_key_create(row[0], row[1], row[2]);

#if DEBUG_ENABLED && DEBUG_AXFR
    DebugX("axfr", 1, _("%s: Loaded TSIG key '%s' algorithm '%s'"),
           desctask(t), row[0], row[1]);
#endif
  }

  sql_free(res);
  return key;
}
/*--- load_tsig_key_for_zone() ------------------------------------------------------------------*/


/**************************************************************************************************
	VERIFY_TSIG_FOR_AXFR
	Verify TSIG signature in AXFR request.
**************************************************************************************************/
static tsig_key_t *
verify_tsig_for_axfr(TASK *t) {
  char key_name[256];
  unsigned char mac[64];
  size_t mac_len = 0;
  uint64_t time_signed = 0;
  uint16_t fudge = 300;
  tsig_key_t *key = NULL;
  time_t now = time(NULL);

  /* Parse TSIG record from Additional section */
  if (parse_tsig_for_axfr(t, key_name, sizeof(key_name),
                          mac, &mac_len, &time_signed, &fudge) != 0) {
    /* No TSIG in request */
    if (tsig_enforce_axfr) {
      dnserror(t, DNS_RCODE_REFUSED, ERR_NO_AXFR);
      return NULL;
    }
    return NULL;  /* No TSIG, but not required */
  }

  /* Load TSIG key from database */
  key = load_tsig_key_for_zone(t, key_name);
  if (!key) {
    Warnx(_("%s: Unknown TSIG key: %s"), desctask(t), key_name);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_NO_AXFR);
    return NULL;
  }

  /* Verify timestamp (within fudge factor) */
  int64_t time_diff = (int64_t)now - (int64_t)time_signed;
  if (time_diff < 0) time_diff = -time_diff;
  if (time_diff > fudge) {
    Warnx(_("%s: TSIG time check failed (diff=%ld, fudge=%u)"),
          desctask(t), (long)time_diff, fudge);
    tsig_key_free(key);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_NO_AXFR);
    return NULL;
  }

  /* Store request MAC for response signing */
  if (mac_len > 0 && mac_len <= sizeof(axfr_request_mac)) {
    memcpy(axfr_request_mac, mac, mac_len);
    axfr_request_mac_len = mac_len;
  }

  /* Verify MAC signature */
  if (tsig_verify((unsigned char*)t->query, t->len, key, NULL, 0, NULL) != 0) {
    Warnx(_("%s: TSIG MAC verification failed for AXFR: key=%s"), desctask(t), key_name);
    tsig_key_free(key);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_NO_AXFR);
    return NULL;
  }

  Notice(_("%s: TSIG verified for AXFR: key=%s"), desctask(t), key_name);
  return key;
}
/*--- verify_tsig_for_axfr() --------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_ZONE
	DNS-based zone transfer.
**************************************************************************************************/
static void
axfr_zone(TASK *t, MYDNS_SOA *soa) {

  /* Check optional "xfer" column and initialize reply */
  check_xfer(t, soa);
  reply_init(t);

  /* Send opening SOA record */
  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
  axfr_reply(t);

  /*
  **  Get all resource records for zone (if zone ID is nonzero, i.e. not manufactured)
  **  and transmit each resource record.
  */
  if (soa->id) {
    MYDNS_RR *ThisRR = NULL, *rr = NULL;

    if (mydns_rr_load_active(sql, &ThisRR, soa->id, DNS_QTYPE_ANY, NULL, soa->origin) == 0) {
      for (rr = ThisRR; rr; rr = rr->next) {
	/* If 'name' doesn't end with a dot, append the origin */
	if (!*MYDNS_RR_NAME(rr) || LASTCHAR(MYDNS_RR_NAME(rr)) != '.') {
	  mydns_rr_name_append_origin(rr, soa->origin);
	}

#if ALIAS_ENABLED
	/*
	 * If we have been compiled with alias support
	 * and the current record is an alias pass it to alias_recurse()
	 */
	if (rr->alias != 0)
	  alias_recurse(t, ANSWER, MYDNS_RR_NAME(rr), soa, NULL, rr);
	else
#endif
	  rrlist_add(t, ANSWER, DNS_RRTYPE_RR, (void *)rr, MYDNS_RR_NAME(rr));
	/* Transmit this resource record */
	axfr_reply(t);
      }
      mydns_rr_free(ThisRR);
    }
  }

  /* Send closing SOA record */
  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
  axfr_reply(t);

  mydns_soa_free(soa);
}
/*--- axfr_zone() -------------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR_GET_SOA
	Attempt to find a SOA record.  If SOA id is 0, we made it up.
**************************************************************************************************/
static MYDNS_SOA *
axfr_get_soa(TASK *t) {
  MYDNS_SOA *soa = NULL;

  /* Try to load SOA */
  if (mydns_soa_load(sql, &soa, t->qname) < 0)
    ErrSQL(sql, "%s: %s", desctask(t), _("error loading zone"));
  if (soa) {
    return (soa);
	}

  /* STILL no SOA?  We aren't authoritative */
  dnserror(t, DNS_RCODE_REFUSED, ERR_ZONE_NOT_FOUND);
  axfr_reply(t);
  axfr_error(t, _("unknown zone"));
  /* NOTREACHED */
  return (NULL);
}
/*--- axfr_get_soa() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	AXFR
	DNS-based zone transfer.  Send all resource records for in QNAME's zone to the client.
**************************************************************************************************/
void
axfr(TASK *t) {
#if DEBUG_ENABLED && DEBUG_AXFR
  struct timeval start = { 0, 0}, finish = { 0, 0 };	/* Time AXFR began and ended */
#endif
  MYDNS_SOA *soa = NULL;				/* SOA record for zone (may be bogus!) */

  /* Do generic startup stuff; this is a child process */
  signal(SIGALRM, axfr_timeout);
  alarm(AXFR_TIME_LIMIT);
  sql_close(sql);
  db_connect();

#if DEBUG_ENABLED && DEBUG_AXFR
  gettimeofday(&start, NULL);
  DebugX("axfr", 1,_("%s: Starting AXFR for task ID %u"), desctask(t), t->internal_id);
#endif
  total_records = total_octets = 0;
  axfr_packet_count = 0;
  axfr_request_mac_len = 0;
  axfr_prev_mac_len = 0;
  t->no_markers = 1;

  /* Get SOA for zone */
  soa = axfr_get_soa(t);

  if (soa){
    /* Verify TSIG if present */
    axfr_tsig_key = verify_tsig_for_axfr(t);

    if (tsig_enforce_axfr && !axfr_tsig_key) {
      /* TSIG required but verification failed */
      axfr_reply(t);
      mydns_soa_free(soa);
      if (axfr_tsig_key) {
        tsig_key_free(axfr_tsig_key);
        axfr_tsig_key = NULL;
      }
      axfr_error(t, _("TSIG verification failed"));
      /* NOTREACHED */
    }

    /* Transfer that zone */
    axfr_zone(t, soa);

    /* Cleanup TSIG key */
    if (axfr_tsig_key) {
      tsig_key_free(axfr_tsig_key);
      axfr_tsig_key = NULL;
    }
  }

#if DEBUG_ENABLED && DEBUG_AXFR
  /* Report result */
  gettimeofday(&finish, NULL);
  DebugX("axfr", 1,_("AXFR: %u records, %u octets, %.3fs"), 
	 (unsigned int)total_records, (unsigned int)total_octets,
	 ((finish.tv_sec + finish.tv_usec / 1000000.0) - (start.tv_sec + start.tv_usec / 1000000.0)));
#endif
  t->qdcount = 1;
  t->an.size = total_records;
  task_output_info(t, NULL);

  sockclose(t->fd);

  _exit(EXIT_SUCCESS);
}
/*--- axfr() ------------------------------------------------------------------------------------*/

void
axfr_fork(TASK *t) {
  int pfd[2] = { -1, -1 };				/* Parent/child pipe descriptors */
  pid_t pid = -1, parent = -1;

#if DEBUG_ENABLED && DEBUG_AXFR 
  DebugX("axfr", 1,_("%s: axfr_fork called on fd %d"), desctask(t), t->fd);
#endif

  if (pipe(pfd))
    Err(_("pipe"));
  parent = getpid();
  if ((pid = fork()) < 0) {
    close(pfd[0]);
    close(pfd[1]);
    Warn(_("%s: fork"), clientaddr(t));
    return;
  }

  if (!pid) {
    /* Child: reset all signal handlers to default before we dive off elsewhere */
    struct sigaction act;

    memset(&act, 0, sizeof(act));

    sigemptyset(&act.sa_mask);
    act.sa_flags = 0;
    act.sa_handler = SIG_DFL;

    sigaction(SIGHUP, &act, NULL);
    sigaction(SIGUSR1, &act, NULL);
    sigaction(SIGUSR2, &act, NULL);
    sigaction(SIGALRM, &act, NULL);
    sigaction(SIGCHLD, &act, NULL);

    sigaction(SIGINT, &act, NULL);
    sigaction(SIGQUIT, &act, NULL);
    sigaction(SIGABRT, &act, NULL);
    sigaction(SIGTERM, &act, NULL);

#if DEBUG_ENABLED && DEBUG_AXFR
    DebugX("axfr", 1,_("%s: axfr_fork is in the child"), desctask(t));
#endif

    /*  Let parent know I have started */
    close(pfd[0]);
    if (write(pfd[1], "OK", 2) != 2)
      Warn(_("error writing startup notification"));
    close(pfd[1]);

#if DEBUG_ENABLED && DEBUG_AXFR
    DebugX("axfr", 1,_("%s: axfr_fork child has told parent I am running"), desctask(t));
#endif

    /* Clean up parents resources */
    free_other_tasks(t, 1);

#if DEBUG_ENABLED && DEBUG_AXFR
    DebugX("axfr", 1,_("%s: AXFR child built"), desctask(t));
#endif
    /* Do AXFR */
    axfr(t);
  } else {	/* Parent */
    char	buf[5] = "\0\0\0\0\0";
    int		errct = 0;

    close(pfd[1]);

    for (errct = 0; errct < 5; errct++) {
      if (read(pfd[0], &buf, 4) != 2)
	Warn(_("%s (%d of 5)"), _("error reading startup notification"), errct+1);
      else
	break;
    }
    close(pfd[0]);

#if DEBUG_ENABLED && DEBUG_AXFR
    DebugX("axfr", 1,_("AXFR: process started on pid %d for TCP fd %d, task ID %u"), pid, t->fd, t->internal_id);
#endif
  }
  /* NOTREACHED*/
}

/* vi:set ts=3: */
/* NEED_PO */
