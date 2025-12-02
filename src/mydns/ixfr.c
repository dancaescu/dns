/**************************************************************************************************
	$Id: notify.c,v 1.0 2007/09/04 10:00:57 howard Exp $

	Copyright (C) 2007 Howard Wilkinson <howard@cohtech.com>

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
#define	DEBUG_IXFR	1

#define DEBUG_IXFR_SQL 1

typedef struct _ixfr_authority_rr {
  uchar			*name;
  dns_qtype_t		type;
  dns_class_t		class;
  uint32_t		ttl;
  uchar			*mname;
  uchar			*rname;
  uint32_t		serial;
  uint32_t		refresh;
  uint32_t		retry;
  uint32_t		expire;
  uint32_t		minimum;
} IARR;

#define IARR_NAME(__rrp)		((__rrp)->name)
#define IARR_MNAME(__rrp)		((__rrp)->mname)
#define IARR_RNAME(__rrp)		((__rrp)->rname)

typedef struct _ixfr_query {
  /* Zone section */
  uchar			*name;				/* The zone name */
  dns_qtype_t		type;				/* Must be DNS_QTYPE_SOA */
  dns_class_t		class;				/* The zone's class */

  IARR			IR;
} IQ;

#define IQ_NAME(__iqp)			((__iqp)->name)

static IQ *
allocate_iq(void) {
  IQ *q = ALLOCATE(sizeof(IQ), IQ);

  memset(q, 0, sizeof(IQ));

  return q;
}

static void
free_iarr_data(IARR *rr) {
  RELEASE(IARR_NAME(rr));
  RELEASE(IARR_MNAME(rr));
  RELEASE(IARR_RNAME(rr));
}

static void
free_iq(IQ *q) {
  free_iarr_data(&q->IR);

  RELEASE(IQ_NAME(q));

  RELEASE(q);
}

static uchar *
ixfr_gobble_authority_rr(TASK *t, uchar *query, size_t querylen, uchar *current, IARR *rr){
  uchar * src = current;
  int rdlength = 0;
  task_error_t errcode = TASK_FAILED;

  if (!(IARR_NAME(rr) = name_unencode2(query, querylen, &src, &errcode))) {
    formerr(t, DNS_RCODE_FORMERR, errcode, NULL);
    return NULL;
  }
  DNS_GET16(rr->type, src);
  DNS_GET16(rr->class, src);
  DNS_GET32(rr->ttl, src);

  DNS_GET16(rdlength, src);
  if (!(IARR_MNAME(rr) = name_unencode2(query, querylen, &src, &errcode))) {
    formerr(t, DNS_RCODE_FORMERR, errcode, NULL);
    return NULL;
  }

  if (!(IARR_RNAME(rr) = name_unencode2(query, querylen, &src, &errcode))) {
    formerr(t, DNS_RCODE_FORMERR, errcode, NULL);
    return NULL;
  }

  DNS_GET32(rr->serial, src);
  DNS_GET32(rr->refresh, src);
  DNS_GET32(rr->retry, src);
  DNS_GET32(rr->expire, src);
  DNS_GET32(rr->minimum, src);

  return src;
}

/**************************************************************************************************
	PARSE_TSIG_FOR_IXFR
	Parse TSIG record from IXFR request Additional section.
	(Reuses same logic as AXFR)
**************************************************************************************************/
static int
parse_tsig_for_ixfr(TASK *t, char *key_name, size_t key_name_size,
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

    /* Parse NAME */
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

/**************************************************************************************************
	LOAD_TSIG_KEY_FOR_IXFR
	Load TSIG key from database by name.
**************************************************************************************************/
static tsig_key_t *
load_tsig_key_for_ixfr(TASK *t, const char *key_name) {
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

#if DEBUG_ENABLED && DEBUG_IXFR
  DebugX("ixfr", 1, _("%s: TSIG KEY LOOKUP: %s"), desctask(t), query);
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

#if DEBUG_ENABLED && DEBUG_IXFR
    DebugX("ixfr", 1, _("%s: Loaded TSIG key '%s' algorithm '%s'"),
           desctask(t), row[0], row[1]);
#endif
  }

  sql_free(res);
  return key;
}

/**************************************************************************************************
	VERIFY_TSIG_FOR_IXFR
	Verify TSIG signature in IXFR request.
**************************************************************************************************/
static tsig_key_t *
verify_tsig_for_ixfr(TASK *t, unsigned char *request_mac_out, size_t *request_mac_len_out) {
  char key_name[256];
  unsigned char mac[64];
  size_t mac_len = 0;
  uint64_t time_signed = 0;
  uint16_t fudge = 300;
  tsig_key_t *key = NULL;
  time_t now = time(NULL);

  /* Parse TSIG record from Additional section */
  if (parse_tsig_for_ixfr(t, key_name, sizeof(key_name),
                          mac, &mac_len, &time_signed, &fudge) != 0) {
    /* No TSIG in request */
    if (tsig_enforce_ixfr) {
      dnserror(t, DNS_RCODE_REFUSED, ERR_ZONE_NOT_FOUND);
      return NULL;
    }
    return NULL;  /* No TSIG, but not required */
  }

  /* Load TSIG key from database */
  key = load_tsig_key_for_ixfr(t, key_name);
  if (!key) {
    Warnx(_("%s: Unknown TSIG key: %s"), desctask(t), key_name);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_ZONE_NOT_FOUND);
    return NULL;
  }

  /* Verify timestamp (within fudge factor) */
  int64_t time_diff = (int64_t)now - (int64_t)time_signed;
  if (time_diff < 0) time_diff = -time_diff;
  if (time_diff > fudge) {
    Warnx(_("%s: TSIG time check failed (diff=%ld, fudge=%u)"),
          desctask(t), (long)time_diff, fudge);
    tsig_key_free(key);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_ZONE_NOT_FOUND);
    return NULL;
  }

  /* Store request MAC for response signing */
  if (request_mac_out && request_mac_len_out && mac_len > 0) {
    memcpy(request_mac_out, mac, mac_len);
    *request_mac_len_out = mac_len;
  }

  /* Verify MAC signature */
  if (tsig_verify((unsigned char*)t->query, t->len, key, NULL, 0, NULL) != 0) {
    Warnx(_("%s: TSIG MAC verification failed for IXFR: key=%s"), desctask(t), key_name);
    tsig_key_free(key);
    dnserror(t, DNS_RCODE_NOTAUTH, ERR_ZONE_NOT_FOUND);
    return NULL;
  }

  Notice(_("%s: TSIG verified for IXFR: key=%s"), desctask(t), key_name);
  return key;
}

taskexec_t
ixfr(TASK * t, datasection_t section, dns_qtype_t qtype, char *fqdn, int truncateonly) {
  MYDNS_SOA	*soa = NULL;
  uchar		*query = (uchar*)t->query;
  int		querylen = t->len;
  uchar		*src = query + DNS_HEADERSIZE;
  IQ		*q = NULL;
  task_error_t	errcode = 0;
  tsig_key_t *tsig_key = NULL;
  unsigned char request_mac[64];
  size_t request_mac_len = 0;

#if DEBUG_ENABLED && DEBUG_IXFR
  DebugX("ixfr", 1, "%s: ixfr(%s, %s, \"%s\", %d)", desctask(t),
	 resolve_datasection_str[section], mydns_qtype_str(qtype), fqdn, truncateonly);
#endif

  if (!dns_ixfr_enabled) {
    dnserror(t, DNS_RCODE_REFUSED, ERR_IXFR_NOT_ENABLED);
    return (TASK_FAILED);
  }

  /*
   * Authority section contains the SOA record for the client's version of the zone
   * only trust the serial number.
   */

  if (mydns_soa_load(sql, &soa, fqdn) < 0) {
    dnserror(t, DNS_RCODE_SERVFAIL, ERR_DB_ERROR);
    return (TASK_FAILED);
  }

  if (!soa) {
    dnserror(t, DNS_RCODE_REFUSED, ERR_ZONE_NOT_FOUND);
    return (TASK_FAILED);
  }

  /* Verify TSIG if present */
  tsig_key = verify_tsig_for_ixfr(t, request_mac, &request_mac_len);

  if (tsig_enforce_ixfr && !tsig_key) {
    /* TSIG required but verification failed */
    mydns_soa_free(soa);
    return (TASK_FAILED);
  }

#if DEBUG_ENABLED && DEBUG_IXFR
  DebugX("ixfr", 1, _("%s: DNS IXFR: SOA id %u"), desctask(t), soa->id);
  DebugX("ixfr", 1, _("%s: DNS IXFR: QDCOUNT=%d (Query)"), desctask(t), t->qdcount);
  DebugX("ixfr", 1, _("%s: DNS IXFR: ANCOUNT=%d (Answer)"), desctask(t), t->ancount);
  DebugX("ixfr", 1, _("%s: DNS IXFR: AUCOUNT=%d (Authority)"), desctask(t), t->nscount);
  DebugX("ixfr", 1, _("%s: DNS IXFR: ADCOUNT=%d (Additional data)"), desctask(t), t->arcount);
#endif
  if (!t->nscount)
    return formerr(t, DNS_RCODE_FORMERR, ERR_NO_AUTHORITY,
		   _("ixfr query contains no authority data"));

  if (t->nscount != 1)
    return formerr(t, DNS_RCODE_FORMERR, ERR_MULTI_AUTHORITY,
		   _("ixfr query contains multiple authority records"));

  if (!t->qdcount)
    return formerr(t, DNS_RCODE_FORMERR, ERR_NO_QUESTION,
		   _("ixfr query does not contain question"));

  if (t->qdcount != 1)
    return formerr(t, DNS_RCODE_FORMERR, ERR_MULTI_QUESTIONS,
		   _("ixfr query contains multiple questions"));

  if (t->ancount)
    return formerr(t, DNS_RCODE_FORMERR, ERR_MALFORMED_REQUEST,
		   _("ixfr query has answer data"));

  /* Additional section is allowed (for TSIG) */

  q = allocate_iq();

  if (!(IQ_NAME(q) = name_unencode2(query, querylen, &src, &errcode))) {
    free_iq(q);
    return formerr(t, DNS_RCODE_FORMERR, errcode, NULL);
  }

  DNS_GET16(q->type, src);
  DNS_GET16(q->class, src);

  if (!(src = ixfr_gobble_authority_rr(t, query, querylen, src, &q->IR))) {
    free_iq(q);
    return (TASK_FAILED);
  }

  /* Get the serial number from the RR record in the authority section */
#if DEBUG_ENABLED && DEBUG_IXFR
  DebugX("ixfr", 1, _("%s: DNS IXFR Question[zone %s qclass %s qtype %s]"
		      " Authority[zone %s qclass %s qtype %s ttl %u "
		      "mname %s rname %s serial %u refresh %u retry %u expire %u minimum %u]"),
	 desctask(t), q->name, mydns_class_str(q->class), mydns_qtype_str(q->type),
	 q->IR.name, mydns_class_str(q->IR.class), mydns_qtype_str(q->IR.type), q->IR.ttl,
	 q->IR.mname, q->IR.rname, q->IR.serial, q->IR.refresh, q->IR.retry, q->IR.expire, q->IR.minimum);
#endif

  /*
   * As per RFC 1995 we have 3 options for a response if a delta exists.
   *
   * We can send a full zone transfer if it will fit in a UDP packet and is smaller
   * than sending deltas
   *
   * We can send a delta transfer if it will fit into a single UDP packet and we can calculate
   * one for the difference between the client and the current serial
   *
   * We can send a packet with a single SOA record for the latest SOA. This will force the client
   * to initiate an AXFR.
   *
   * We can calculate the size of the response by either building both messages
   * or by an estimation technique. In either case we need to look at the data.
   *
   * I have chosen to check for altered records within the database first.
   *
   * First check is to make sure that the serial held by the client is not the current one
   *
   * Next check to see if out incremental data for the transition from client serial
   * to current serial has not expired.
   *
   * Then retrieve the updated records between the client serial and the latest serial.
   * and retrieve the entire zone ... a record count is the first check.
   *
   * If the number of delta records is larger than the number of zone records then send the zone
   *
   * Calculate the size of the variable parts of the record and compare.
   * We assume that name encoding will have an equal effect on the data.
   * So having chosen to send either the zone or the deltas construct the packet.
   *
   * Check that the packet has not overflowed the UDP limit and send. If it has
   * that abandon the packet and send one containing just the latest SOA.
   *
   */

  if (soa->serial == q->IR.serial) {
    /* Tell the client to do no zone transfer */
    rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
    t->sort_level++;
  } else {
    /* Do we have incremental information in the database */
    if (!truncateonly && mydns_rr_use_active && mydns_rr_use_stamp && mydns_rr_use_serial) {
      /* We can do incrementals */
      /* Need to send an IXFR if available */
      /*
       * Work out when the client SOA came into being
       */
      MYDNS_RR	*ThisRR = NULL, *rr = NULL;
      char	*deltafilter = NULL;
      int	deletecount, activecount, zonesize;
      size_t	deltasize, fullsize;
       
      /* For very large zones we do not want to load all of the records just to give up */
      sql_build_query(&deltafilter, "serial > %u", q->IR.serial);

      /*
       * Compare counts of changes from full zone data
       * ... assumes records are about the same size
       * approximate zone size by 2 * deleted count === actual number of delta records
       */
      deletecount = mydns_rr_count_deleted_filtered(sql,
							soa->id, DNS_QTYPE_ANY, NULL,
							soa->origin, deltafilter);
      activecount = mydns_rr_count_active_filtered(sql,
						       soa->id, DNS_QTYPE_ANY, NULL,
						       soa->origin, deltafilter);
      zonesize = mydns_rr_count_active(sql,
					   soa->id, DNS_QTYPE_ANY, NULL,
					   soa->origin);
      deltasize = deletecount + activecount + 4;
      fullsize = zonesize + 2;

      if ((deletecount < 0) || (activecount < 0) || (zonesize < 0)) {
	RELEASE(deltafilter);
	dnserror(t, DNS_RCODE_SERVFAIL, ERR_DB_ERROR);
	return (TASK_FAILED);
      }
      if (deletecount || activecount) {
	if (deltasize >= fullsize) {
	  /* Send a full zone transfer */
	  /* Current Serial first */
	  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	  t->sort_level++;
	  if (mydns_rr_load_active(sql, &ThisRR, soa->id, DNS_QTYPE_ANY, NULL, soa->origin) == 0) {
	    for (rr = ThisRR; rr; rr = rr->next) {
	      char *name = mydns_rr_append_origin(MYDNS_RR_NAME(rr), soa->origin);
	      rrlist_add(t, ANSWER, DNS_RRTYPE_RR, (void *)rr, name);
	      if (name != MYDNS_RR_NAME(rr)) RELEASE(name);
	    }
	    t->sort_level++;
	    mydns_rr_free(ThisRR);
	    rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	    t->sort_level++;
	  }
	} else {
	  int latest_serial = soa->serial;

	  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	  t->sort_level++;
	  soa->serial = q->IR.serial;
	  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	  t->sort_level++;
	  soa->serial = latest_serial;
	  if (mydns_rr_load_deleted_filtered(sql, &ThisRR, soa->id, DNS_QTYPE_ANY, NULL, soa->origin,
					     deltafilter) == 0) {
	    for (rr = ThisRR; rr; rr = rr->next) {
	      char *name = mydns_rr_append_origin(MYDNS_RR_NAME(rr), soa->origin);
	      rrlist_add(t, ANSWER, DNS_RRTYPE_RR, (void *)rr, name);
	      if (name != MYDNS_RR_NAME(rr)) RELEASE(name);
	    }
	    t->sort_level++;
	    mydns_rr_free(ThisRR);
	  }
	  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	  t->sort_level++;
	  if (mydns_rr_load_active_filtered(sql, &ThisRR, soa->id, DNS_QTYPE_ANY, NULL, soa->origin,
					    deltafilter) == 0) {
	    for (rr = ThisRR; rr; rr = rr->next) {
	      char *name = mydns_rr_append_origin(MYDNS_RR_NAME(rr), soa->origin);
	      rrlist_add(t, ANSWER, DNS_RRTYPE_RR, (void *)rr, name);
	      if (name != MYDNS_RR_NAME(rr)) RELEASE(name);
	    }
	    t->sort_level++;
	    mydns_rr_free(ThisRR);
	    rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
	    t->sort_level++;
	  }
	  RELEASE(deltafilter);
	}
	goto FINISHEDIXFR;
      }
    }
  }

  /* Tell the client to do a full zone transfer or not at all */
  rrlist_add(t, ANSWER, DNS_RRTYPE_SOA, (void *)soa, soa->origin);
  t->sort_level++;

 FINISHEDIXFR:
  mydns_soa_free(soa);

  free_iq(q);

  t->hdr.aa = 1;

  /* Sign response with TSIG if request was signed */
  if (tsig_key && request_mac_len > 0) {
    /* Build reply first (if not already built) */
    if (!t->reply || t->replylen == 0) {
      build_reply(t, 0);
    }

    /* Allocate buffer for signed reply */
    size_t max_tsig_len = 200;
    char *signed_reply = ALLOCATE(t->replylen + max_tsig_len, char[]);
    size_t new_len = 0;

    if (signed_reply) {
      memcpy(signed_reply, t->reply, t->replylen);

      /* Sign the reply with request MAC (single packet, no chaining needed) */
      if (tsig_sign((unsigned char*)signed_reply, t->replylen, t->replylen + max_tsig_len,
                    tsig_key, request_mac, request_mac_len, &new_len) == 0) {

        /* Replace reply with signed version */
        RELEASE(t->reply);
        t->reply = signed_reply;
        t->replylen = new_len;

#if DEBUG_ENABLED && DEBUG_IXFR
        DebugX("ixfr", 1, _("%s: IXFR response signed with TSIG (%zu bytes)"),
               desctask(t), new_len);
#endif
      } else {
        /* Signing failed - send unsigned */
        Warnx(_("%s: TSIG signing failed for IXFR response"), desctask(t));
        RELEASE(signed_reply);
      }
    } else {
      Warnx(_("%s: Failed to allocate buffer for TSIG signing"), desctask(t));
    }

    /* Free TSIG key */
    tsig_key_free(tsig_key);
    tsig_key = NULL;
  }

  return (TASK_EXECUTED);
}

static taskexec_t
ixfr_purge_all_soas(TASK *t, void *data) {

  /*
   * Retrieve all zone id's that have deleted records.
   *
   * For each zone get the expire field and delete any records that have expired.
   *
   */

  SQL_RES	*res = NULL;
  SQL_ROW	row = NULL;

  size_t	querylen;
  const char	*QUERY0 =	"SELECT DISTINCT zone FROM %s WHERE active='%s'";
  const char	*QUERY1 = 	"SELECT origin FROM %s "
				"WHERE id=%u;";
  const char	*QUERY2 =	"DELETE FROM %s WHERE zone=%u AND active='%s' "
				" AND stamp < DATE_SUB(NOW(),INTERVAL %u SECOND);";
  char		*query = NULL;

  /*
   * Reset task timeout clock to some suitable value in the future
   */
  t->timeout = current_time + ixfr_gc_interval;	/* Try again e.g. tomorrow */

  querylen = sql_build_query(&query, QUERY0,
			     mydns_rr_table_name, mydns_rr_active_types[2]);

  if (!(res = sql_query(sql, query, querylen)))
    ErrSQL(sql, "%s: %s", desctask(t),
	   _("error loading zone id's for DELETED records"));

  RELEASE(query);

  while((row = sql_getrow(res, NULL))) {
    unsigned int	id = atou(row[0]);
    char		*origin = NULL;
    MYDNS_SOA		*soa = NULL;
    SQL_RES		*sres = NULL;

    querylen = sql_build_query(&query, QUERY1,
			       mydns_soa_table_name, id);

    if (!(res = sql_query(sql, query, querylen)))
      ErrSQL(sql, "%s: %s", desctask(t),
	     _("error loading zone from DELETED record zone id"));

    RELEASE(query);

    if (!(row = sql_getrow(res, NULL))) {
      Warnx(_("%s: no soa found for soa id %u"), desctask(t),
	    id);
      continue;
    }

    origin = row[0];

    if (mydns_soa_load(sql, &soa, origin) == 0) {
      querylen = sql_build_query(&query, QUERY2,
				 mydns_rr_table_name, soa->id, mydns_rr_active_types[2], soa->expire);

      if (sql_nrquery(sql, query, querylen) != 0)
	WarnSQL(sql, "%s: %s %s", desctask(t),
		_("error deleting expired records for zone "), soa->origin);

      RELEASE(query);

      sql_free(sres);
    }
  }

  sql_free(res);
  RELEASE(query);     

  return (TASK_CONTINUE);
}

void
ixfr_start() {

  TASK *inittask = NULL;

  if (!ixfr_gc_enabled) return;

  /* Only GC if the DB has IXFR information in it */
  if (mydns_rr_use_active && mydns_rr_use_stamp && mydns_rr_use_serial) {
    inittask = Ticktask_init(LOW_PRIORITY_TASK, NEED_TASK_RUN, -1, 0, AF_UNSPEC, NULL);
    task_add_extension(inittask, NULL, NULL, NULL, ixfr_purge_all_soas);

    inittask->timeout = current_time + ixfr_gc_delay; /* Run first one in e.g. 10 minutes time */
  }
}

/* vi:set ts=3: */
/* NEED_PO */
