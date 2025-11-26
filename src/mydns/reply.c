/**************************************************************************************************
	$Id: reply.c,v 1.65 2006/01/18 20:46:47 bboy Exp $

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

/* Make this nonzero to enable debugging for this source file */
#define	DEBUG_REPLY	1

#if DEBUG_ENABLED && DEBUG_REPLY
/* Strings describing the datasections */
const char *reply_datasection_str[] = { "QUESTION", "ANSWER", "AUTHORITY", "ADDITIONAL" };
#endif


/**************************************************************************************************
	REPLY_INIT
	Examines the question data, storing the name offsets (from DNS_HEADERSIZE) for compression.
**************************************************************************************************/
int
reply_init(TASK *t) {
  register char *c = NULL;						/* Current character in name */

  /* Examine question data, save labels found therein. The question data should begin with
     the name we've already parsed into t->qname.  I believe it is safe to assume that no
     compression will be possible in the question. */
  for (c = t->qname; *c; c++)
    if ((c == t->qname || *c == '.') && c[1])
      if (name_remember(t, (c == t->qname) ? c : (c+1),
			(((c == t->qname) ? c : (c+1)) - t->qname) + DNS_HEADERSIZE) < -1)
	return (-1);
  return (0);
}
/*--- reply_init() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_ADDITIONAL
	Add ADDITIONAL for each item in the provided list.
**************************************************************************************************/
static void
reply_add_additional(TASK *t, RRLIST *rrlist) {
  register RR *p = NULL;

  if (!rrlist)
    return;

  /* Examine each RR in the rrlist */
  for (p = rrlist->head; p; p = p->next) {
    if (p->rrtype == DNS_RRTYPE_RR) {
      MYDNS_RR *rr = (MYDNS_RR *)p->rr;
      if (rr->type == DNS_QTYPE_NS || rr->type == DNS_QTYPE_MX || rr->type == DNS_QTYPE_SRV) {
	(void)resolve(t, ADDITIONAL, DNS_QTYPE_A, MYDNS_RR_DATA_VALUE(rr), 0);
      }	else if (rr->type == DNS_QTYPE_CNAME) {
	/* Don't do this */
	(void)resolve(t, ADDITIONAL, DNS_QTYPE_CNAME, MYDNS_RR_DATA_VALUE(rr), 0);
      }
    }
    t->sort_level++;
  }
}
/*--- reply_add_additional() --------------------------------------------------------------------*/

#include <math.h>

#define LOC_DEFAULT_SIZE_METERS		1.0
#define LOC_DEFAULT_HP_METERS		10000.0
#define LOC_DEFAULT_VP_METERS		10.0
#define LOC_SECONDS_SCALE		(3600.0 * 1000.0)
#define LOC_ALTITUDE_OFFSET_METERS	100000.0

static char *
loc_next_token(char **input) {
  char *s = NULL, *start = NULL;

  if (!input || !*input)
    return NULL;

  s = *input;
  while (*s && isspace((unsigned char)*s))
    s++;
  if (!*s) {
    *input = s;
    return NULL;
  }
  start = s;
  while (*s && !isspace((unsigned char)*s))
    s++;
  if (*s)
    *s++ = '\0';
  *input = s;
  return start;
}

static char *
loc_clean_token(char *tok) {
  char *end = NULL;

  if (!tok)
    return NULL;

  while (*tok == '(')
    tok++;

  end = tok + strlen(tok);
  while (end > tok && (end[-1] == ')' || end[-1] == ',')) {
    *--end = '\0';
  }

  return tok;
}

static int
loc_token_is_comment(const char *tok) {
  return (tok && tok[0] == ';');
}

static int
loc_is_hemisphere(const char *tok, int is_lat) {
  char c;

  if (!tok || !tok[0] || tok[1])
    return 0;
  c = tolower((unsigned char)tok[0]);
  if (is_lat)
    return (c == 'n' || c == 's');
  return (c == 'e' || c == 'w');
}

static int
loc_parse_distance(char *tok, double *meters) {
  char *clean = NULL;
  char *endptr = NULL;
  double val = 0.0;

  if (!tok || !meters)
    return (-1);

  clean = loc_clean_token(tok);
  if (!clean || !*clean)
    return (-1);

  endptr = clean + strlen(clean) - 1;
  while (endptr >= clean && isspace((unsigned char)*endptr)) {
    *endptr-- = '\0';
  }
  if (endptr >= clean && (*endptr == 'm' || *endptr == 'M')) {
    *endptr-- = '\0';
  }
  while (endptr >= clean && isspace((unsigned char)*endptr)) {
    *endptr-- = '\0';
  }
  if (!*clean)
    return (-1);

  val = strtod(clean, &endptr);
  if (endptr == clean || !isfinite(val))
    return (-1);
  *meters = val;
  return (0);
}

static int
loc_parse_coord(char **cursor, int is_lat, double *value) {
  double deg = 0.0, min = 0.0, sec = 0.0;
  char *tok = NULL;
  char *hemi = NULL;
  double maxdeg = is_lat ? 90.0 : 180.0;

  if (!cursor || !value)
    return (-1);

  tok = loc_clean_token(loc_next_token(cursor));
  if (!tok || !*tok)
    return (-1);
  deg = strtod(tok, NULL);
  if (!isfinite(deg))
    return (-1);

  tok = loc_clean_token(loc_next_token(cursor));
  if (!tok)
    return (-1);

  if (loc_is_hemisphere(tok, is_lat)) {
    hemi = tok;
  } else {
    min = strtod(tok, NULL);
    if (!isfinite(min))
      return (-1);
    tok = loc_clean_token(loc_next_token(cursor));
    if (!tok)
      return (-1);
    if (loc_is_hemisphere(tok, is_lat)) {
      hemi = tok;
    } else {
      sec = strtod(tok, NULL);
      if (!isfinite(sec))
	return (-1);
      tok = loc_clean_token(loc_next_token(cursor));
      if (!tok || !loc_is_hemisphere(tok, is_lat))
	return (-1);
      hemi = tok;
    }
  }

  if (!hemi)
    return (-1);

  deg += min / 60.0 + sec / 3600.0;
  if (deg > maxdeg)
    return (-1);

  if ((is_lat && tolower((unsigned char)hemi[0]) == 's') ||
      (!is_lat && tolower((unsigned char)hemi[0]) == 'w'))
    deg = -deg;

  *value = deg;
  return (0);
}

static uint8_t
loc_encode_precision(double meters) {
  uint32_t cm = 0;
  uint8_t exp = 0;

  if (meters < 0)
    meters = 0;
  cm = (uint32_t)(meters * 100.0 + 0.5);

  while (cm > 9 && exp < 9) {
    cm = (cm + 5) / 10;
    exp++;
  }
  if (cm > 9)
    cm = 9;

  return (uint8_t)((cm << 4) | (exp & 0x0F));
}

static uint32_t
loc_encode_coord(double degrees, int is_lat) {
  double maxdeg = is_lat ? 90.0 : 180.0;
  double scaled = 0.0;
  int64_t value = 0;

  if (degrees > maxdeg)
    degrees = maxdeg;
  if (degrees < -maxdeg)
    degrees = -maxdeg;

  scaled = degrees * LOC_SECONDS_SCALE;
  value = (int64_t)((scaled >= 0) ? (scaled + 0.5) : (scaled - 0.5));
  value += (int64_t)0x80000000;
  if (value < 0)
    value = 0;
  if (value > 0xFFFFFFFF)
    value = 0xFFFFFFFF;
  return (uint32_t)value;
}

static int
loc_build_rdata(const char *input, uint8_t rdata[16]) {
  char *work = NULL, *cursor = NULL, *tok = NULL;
  double lat = 0.0, lon = 0.0, alt = 0.0;
  double size = LOC_DEFAULT_SIZE_METERS;
  double hp = LOC_DEFAULT_HP_METERS;
  double vp = LOC_DEFAULT_VP_METERS;
  uint32_t coord;

  if (!input || !rdata)
    return (-1);

  work = STRDUP(input);
  if (!work)
    return (-1);
  cursor = work;

  if (loc_parse_coord(&cursor, 1, &lat) < 0 ||
      loc_parse_coord(&cursor, 0, &lon) < 0) {
    RELEASE(work);
    return (-1);
  }

  tok = loc_clean_token(loc_next_token(&cursor));
  if (!tok || !*tok || loc_token_is_comment(tok)) {
    RELEASE(work);
    return (-1);
  }
  if (loc_parse_distance(tok, &alt) < 0 || !isfinite(alt)) {
    RELEASE(work);
    return (-1);
  }

  tok = loc_clean_token(loc_next_token(&cursor));
  if (tok && *tok && !loc_token_is_comment(tok)) {
    if (loc_parse_distance(tok, &size) < 0 || !isfinite(size)) {
      RELEASE(work);
      return (-1);
    }
    tok = loc_clean_token(loc_next_token(&cursor));
    if (tok && *tok && !loc_token_is_comment(tok)) {
      if (loc_parse_distance(tok, &hp) < 0 || !isfinite(hp)) {
	RELEASE(work);
	return (-1);
      }
      tok = loc_clean_token(loc_next_token(&cursor));
      if (tok && *tok && !loc_token_is_comment(tok)) {
	if (loc_parse_distance(tok, &vp) < 0 || !isfinite(vp)) {
	  RELEASE(work);
	  return (-1);
	}
      }
    }
  }

  if (size < 0) size = 0;
  if (hp < 0) hp = 0;
  if (vp < 0) vp = 0;

  rdata[0] = 0; /* version */
  rdata[1] = loc_encode_precision(size);
  rdata[2] = loc_encode_precision(hp);
  rdata[3] = loc_encode_precision(vp);

  coord = loc_encode_coord(lat, 1);
  {
    char *pos = (char *)&rdata[4];
    DNS_PUT32(pos, coord);
  }

  coord = loc_encode_coord(lon, 0);
  {
    char *pos = (char *)&rdata[8];
    DNS_PUT32(pos, coord);
  }

  {
    double alt_cm = (alt + LOC_ALTITUDE_OFFSET_METERS) * 100.0;
    int64_t alt_val = (int64_t)((alt_cm >= 0) ? (alt_cm + 0.5) : (alt_cm - 0.5));
    if (alt_val < 0)
      alt_val = 0;
    if (alt_val > 0xFFFFFFFF)
      alt_val = 0xFFFFFFFF;
    {
      char *pos = (char *)&rdata[12];
      DNS_PUT32(pos, (uint32_t)alt_val);
    }
  }

  RELEASE(work);
  return (0);
}


/**************************************************************************************************
	RDATA_ENLARGE
	Expands t->rdata by `size' bytes.  Returns a pointer to the destination.
**************************************************************************************************/
static char *
rdata_enlarge(TASK *t, size_t size) {
  if (!size)
    return (NULL);

  t->rdlen += size;
  t->rdata = REALLOCATE(t->rdata, t->rdlen, char[]);
  return (t->rdata + t->rdlen - size);
}
/*--- rdata_enlarge() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_START_RR
	Begins an RR.  Appends to t->rdata all the header fields prior to rdlength.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static int
reply_start_rr(TASK *t, RR *r, const char *name, dns_qtype_t type, uint32_t ttl, const char *desc) {
  char	*enc = NULL;
  char	*dest = NULL;
  int	enclen = 0;

  /* name_encode returns dnserror() */
  if ((enclen = name_encode2(t, &enc, name, t->replylen + t->rdlen, 1)) < 0) {
    return rr_error(r->id, _("rr %u: %s (%s %s) (name=\"%s\")"), r->id,
		    _("invalid name in \"name\""), desc, _("record"), name);
  }

  r->length = enclen + SIZE16 + SIZE16 + SIZE32;

  if (!(dest = rdata_enlarge(t, r->length))) {
    RELEASE(enc);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  }

  r->offset = dest - t->rdata + DNS_HEADERSIZE + t->qdlen;

  DNS_PUT(dest, enc, enclen);
  RELEASE(enc);
  DNS_PUT16(dest, type);
#if STATUS_ENABLED
  if (r->rrtype == DNS_RRTYPE_RR && r->rr)
    DNS_PUT16(dest, ((MYDNS_RR *)(r->rr))->class)
    else
#endif
      DNS_PUT16(dest, DNS_CLASS_IN);
  DNS_PUT32(dest, ttl);
  return (0);
}
/*--- reply_start_rr() --------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_GENERIC_RR
	Adds a generic resource record whose sole piece of data is a domain-name,
	or a 16-bit value plus a domain-name.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_generic_rr(TASK *t, RR *r, const char *desc) {
  char		*enc = NULL, *dest = NULL;
  int		size = 0, enclen = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;

  if (reply_start_rr(t, r, (char*)r->name, rr->type, rr->ttl, desc) < 0)
    return (-1);

  if ((enclen = name_encode2(t, &enc, MYDNS_RR_DATA_VALUE(rr), CUROFFSET(t), 1)) < 0) {
    return rr_error(r->id, _("rr %u: %s (%s) (data=\"%s\")"), r->id,
		    _("invalid name in \"data\""), desc, (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  size = enclen;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    RELEASE(enc);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  }

  DNS_PUT16(dest, size);
  DNS_PUT(dest, enc, enclen);
  RELEASE(enc);
  return (0);
}
/*--- reply_add_generic_rr() --------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_A
	Adds an A record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_a(TASK *t, RR *r) {
  char		*dest = NULL;
  int		size = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  struct in_addr addr;
  uint32_t	ip = 0;
  const char	*data_value = MYDNS_RR_DATA_VALUE(rr);
  char		*geo_data = NULL;
  int		zone_geoip_enabled = 0;

  memset(&addr, 0, sizeof(addr));

  /* Check for GeoIP-specific data */
  if (GeoIP && t->client_sensor_id > 0 && t->zone > 0) {
    /* Check if zone has GeoIP enabled */
    zone_geoip_enabled = geoip_zone_enabled(GeoIP, t->zone);
    if (zone_geoip_enabled == 1) {
      /* Try to get location-specific data */
      geo_data = geoip_get_rr_data(GeoIP, r->id, t->client_sensor_id);
      if (geo_data) {
        data_value = geo_data;
#if DEBUG_ENABLED
        Debug(_("GeoIP: Using location-specific IP for rr %u: %s"), r->id, data_value);
#endif
      }
    }
  }

  if (inet_pton(AF_INET, data_value, (void *)&addr) <= 0) {
    dnserror(t, DNS_RCODE_SERVFAIL, ERR_INVALID_ADDRESS);
    return rr_error(r->id, _("rr %u: %s (A %s) (address=\"%s\")"), r->id,
		    _("invalid address in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }
  ip = ntohl(addr.s_addr);

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_A, rr->ttl, "A") < 0)
    return (-1);

  size = SIZE32;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size)))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, size);
  DNS_PUT32(dest, ip);

  /* Free geo_data if allocated */
  if (geo_data) {
    free(geo_data);
  }

  return (0);
}
/*--- reply_add_a() -----------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_AAAA
	Adds an AAAA record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_aaaa(TASK *t, RR *r) {
  char		*dest = NULL;
  int		size = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  uint8_t	addr[16];
  const char	*data_value = MYDNS_RR_DATA_VALUE(rr);
  char		*geo_data = NULL;
  int		zone_geoip_enabled = 0;

  memset(&addr, 0, sizeof(addr));

  /* Check for GeoIP-specific data */
  if (GeoIP && t->client_sensor_id > 0 && t->zone > 0) {
    /* Check if zone has GeoIP enabled */
    zone_geoip_enabled = geoip_zone_enabled(GeoIP, t->zone);
    if (zone_geoip_enabled == 1) {
      /* Try to get location-specific data */
      geo_data = geoip_get_rr_data(GeoIP, r->id, t->client_sensor_id);
      if (geo_data) {
        data_value = geo_data;
#if DEBUG_ENABLED
        Debug(_("GeoIP: Using location-specific IPv6 for rr %u: %s"), r->id, data_value);
#endif
      }
    }
  }

  if (inet_pton(AF_INET6, data_value, (void *)&addr) <= 0) {
    dnserror(t, DNS_RCODE_SERVFAIL, ERR_INVALID_ADDRESS);
    return rr_error(r->id, _("rr %u: %s (AAAA %s) (address=\"%s\")"), r->id,
		    _("invalid address in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_AAAA, rr->ttl, "AAAA") < 0)
    return (-1);

  size = sizeof(uint8_t) * 16;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size)))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, size);
  memcpy(dest, &addr, size);
  dest += size;

  /* Free geo_data if allocated */
  if (geo_data) {
    free(geo_data);
  }

  return (0);
}
/*--- reply_add_aaaa() --------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_LOC
	Adds a LOC record to the reply.
**************************************************************************************************/
static inline int
reply_add_loc(TASK *t, RR *r) {
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  uint8_t	locdata[16];
  char		*dest = NULL;

  if (loc_build_rdata(MYDNS_RR_DATA_VALUE(rr), locdata) < 0) {
    return rr_error(r->id, _("rr %u: %s (LOC %s) (data=\"%s\")"), r->id,
		    _("invalid LOC data in \"data\""), _("record"),
		    (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_LOC, rr->ttl, "LOC") < 0)
    return (-1);

  r->length += SIZE16 + sizeof(locdata);

  if (!(dest = rdata_enlarge(t, SIZE16 + sizeof(locdata))))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, sizeof(locdata));
  memcpy(dest, locdata, sizeof(locdata));
  return (0);
}
/*--- reply_add_loc() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_HINFO
	Adds an HINFO record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static int
reply_add_hinfo(TASK *t, RR *r) {
  char		*dest = NULL;
  size_t	oslen = 0, cpulen = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  char		os[DNS_MAXNAMELEN + 1] = "", cpu[DNS_MAXNAMELEN + 1] = "";

  if (hinfo_parse(MYDNS_RR_DATA_VALUE(rr), cpu, os, DNS_MAXNAMELEN) < 0) {
    dnserror(t, DNS_RCODE_SERVFAIL, ERR_RR_NAME_TOO_LONG);
    return rr_error(r->id, _("rr %u: %s (HINFO %s) (data=\"%s\")"), r->id,
		    _("name too long in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  cpulen = strlen(cpu);
  oslen = strlen(os);

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_HINFO, rr->ttl, "HINFO") < 0)
    return (-1);

  r->length += SIZE16 + cpulen + oslen + 2;

  if (!(dest = rdata_enlarge(t, SIZE16 + cpulen + SIZE16 + oslen)))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, cpulen + oslen + 2);

  *dest++ = cpulen;
  memcpy(dest, cpu, cpulen);
  dest += cpulen;

  *dest++ = oslen;
  memcpy(dest, os, oslen);
  dest += oslen;

  return (0);
}
/*--- reply_add_hinfo() -------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_MX
	Adds an MX record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_mx(TASK *t, RR *r) {
  char		*enc = NULL, *dest = NULL;
  int		size = 0, enclen = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_MX, rr->ttl, "MX") < 0)
    return (-1);

  if ((enclen = name_encode2(t, &enc, MYDNS_RR_DATA_VALUE(rr), CUROFFSET(t) + SIZE16, 1)) < 0) {
    return rr_error(r->id, _("rr %u: %s (MX %s) (data=\"%s\")"), r->id,
		    _("invalid name in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  size = SIZE16 + enclen;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    RELEASE(enc);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  }

  DNS_PUT16(dest, size);
  DNS_PUT16(dest, (uint16_t)rr->aux);
  DNS_PUT(dest, enc, enclen);
  RELEASE(enc);
  return (0);
}
/*--- reply_add_mx() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_NAPTR
	Adds an NAPTR record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_naptr(TASK *t, RR *r) {
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  size_t	flags_len = 0, service_len = 0, regex_len = 0;
  char		*enc = NULL, *dest = NULL;
  int		size = 0, enclen = 0, offset = 0;
  uint16_t	order = 0, pref = 0;
  char		*flags = NULL, *service = NULL, *regex = NULL, *replacement = NULL;

  if (mydns_rr_naptr_values(rr, &order, &pref, &flags, &service, &regex, &replacement) < 0) {
    return rr_error(r->id, _("rr %u: %s (NAPTR %s) (data=\"%s\")"), r->id,
		    _("invalid data in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  flags_len = strlen(flags);
  service_len = strlen(service);
  regex_len = strlen(regex);

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_NAPTR, rr->ttl, "NAPTR") < 0)
    goto fail;

  /* We are going to write "something else" and then a name, just like an MX record or something.
     In this case, though, the "something else" is lots of data.  Calculate the size of
     "something else" in 'offset' */
  offset = SIZE16 + SIZE16 + 1 + flags_len + 1 + service_len + 1 + regex_len;

  /* Encode the name at the offset */
  if ((enclen = name_encode2(t, &enc, replacement, CUROFFSET(t) + offset, 1)) < 0)
    goto fail;

  size = offset + enclen;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    goto fail;
  }

  DNS_PUT16(dest, size);
  DNS_PUT16(dest, order);
  DNS_PUT16(dest, pref);

  *dest++ = flags_len;
  memcpy(dest, flags, flags_len);
  dest += flags_len;

  *dest++ = service_len;
  memcpy(dest, service, service_len);
  dest += service_len;

  *dest++ = regex_len;
  memcpy(dest, regex, regex_len);
  dest += regex_len;

  DNS_PUT(dest, enc, enclen);
  RELEASE(enc);
  RELEASE(flags);
  RELEASE(service);
  RELEASE(regex);
  RELEASE(replacement);

  return (0);

fail:
  RELEASE(enc);
  RELEASE(flags);
  RELEASE(service);
  RELEASE(regex);
  RELEASE(replacement);
  return rr_error(r->id, _("rr %u: %s (NAPTR %s) (%s=\"%s\")"), r->id,
		  _("invalid name in \"replacement\""), _("record"), _("replacement"),
		  (char*)MYDNS_RR_DATA_VALUE(rr));
}
/*--- reply_add_naptr() -------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_RP
	Adds an RP record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_rp(TASK *t, RR *r) {
  char		*mbox = NULL, *txt = NULL, *dest = NULL;
  char		*encmbox = NULL, *enctxt = NULL;
  int		size = 0, mboxlen = 0, txtlen = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;

  if (mydns_rr_rp_values(rr, &mbox, &txt) < 0) {
    return rr_error(r->id, _("rr %u: %s (RP %s) (data=\"%s\")"), r->id,
		    _("invalid data in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_RP, rr->ttl, "RP") < 0)
    goto fail;

  if ((mboxlen = name_encode2(t, &encmbox, mbox, CUROFFSET(t), 1)) < 0) {
    goto fail;
  }

  if ((txtlen = name_encode2(t, &enctxt, txt, CUROFFSET(t) + mboxlen, 1)) < 0) {
    goto fail;
  }

  size = mboxlen + txtlen;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    RELEASE(encmbox);
    RELEASE(enctxt);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  }

  DNS_PUT16(dest, size);
  DNS_PUT(dest, encmbox, mboxlen);
  DNS_PUT(dest, enctxt, txtlen);
  RELEASE(encmbox);
  RELEASE(enctxt);
  RELEASE(mbox);
  RELEASE(txt);
  return (0);

fail:
  RELEASE(encmbox);
  RELEASE(enctxt);
  RELEASE(mbox);
  RELEASE(txt);
  return rr_error(r->id, _("rr %u: %s (RP %s) (data=\"%s\")"), r->id,
		  _("invalid name in \"mbox\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
}
/*--- reply_add_rp() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_SOA
	Add a SOA record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_soa(TASK *t, RR *r) {
  char		*dest = NULL, *ns = NULL, *mbox = NULL;
  int		size = 0, nslen = 0, mboxlen = 0;
  MYDNS_SOA	*soa = (MYDNS_SOA *)r->rr;

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_SOA, soa->ttl, "SOA") < 0)
    return (-1);

  if ((nslen = name_encode2(t, &ns, soa->ns, CUROFFSET(t), 1)) < 0) {
    return rr_error(r->id, _("rr %u: %s (SOA %s) (ns=\"%s\")"), r->id,
		    _("invalid name in \"ns\""), _("record"), soa->ns);
  }

  if ((mboxlen = name_encode2(t, &mbox, soa->mbox, CUROFFSET(t) + nslen, 1)) < 0) {
    RELEASE(ns);
    return rr_error(r->id, _("rr %u: %s (SOA %s) (mbox=\"%s\")"), r->id,
		    _("invalid name in \"mbox\""), _("record"), soa->mbox);
  }

  size = nslen + mboxlen + (SIZE32 * 5);
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    RELEASE(ns);
    RELEASE(mbox);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  }

  DNS_PUT16(dest, size);
  DNS_PUT(dest, ns, nslen);
  DNS_PUT(dest, mbox, mboxlen);
  RELEASE(ns);
  RELEASE(mbox);
  DNS_PUT32(dest, soa->serial);
  DNS_PUT32(dest, soa->refresh);
  DNS_PUT32(dest, soa->retry);
  DNS_PUT32(dest, soa->expire);
  DNS_PUT32(dest, soa->minimum);
  return (0);
}
/*--- reply_add_soa() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_SRV
	Adds a SRV record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_srv(TASK *t, RR *r) {
  char		*enc = NULL, *dest = NULL;
  int		size = 0, enclen = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;
  uint16_t	priority = 0, weight = 0, port = 0;
  char		*target = NULL;

  if (mydns_rr_srv_values(rr, &priority, &weight, &port, &target) < 0) {
    return rr_error(r->id, _("rr %u: %s (SRV %s) (data=\"%s\")"), r->id,
		    _("invalid data in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
  }

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_SRV, rr->ttl, "SRV") < 0)
    goto fail;

  /* RFC 2782 says that we can't use name compression on this field... */
  /* Arnt Gulbrandsen advises against using compression in the SRV target, although
     most clients should support it */
  if ((enclen = name_encode2(t, &enc, target, CUROFFSET(t) + SIZE16 + SIZE16 + SIZE16, 0)) < 0)
    goto fail;

  size = SIZE16 + SIZE16 + SIZE16 + enclen;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size))) {
    goto fail;
  }

  DNS_PUT16(dest, size);
  DNS_PUT16(dest, priority);
  DNS_PUT16(dest, weight);
  DNS_PUT16(dest, port);
  DNS_PUT(dest, enc, enclen);
  RELEASE(enc);
  RELEASE(target);
  return (0);

fail:
  RELEASE(enc);
  RELEASE(target);
  return rr_error(r->id, _("rr %u: %s (SRV %s) (data=\"%s\")"), r->id,
		  _("invalid name in \"data\""), _("record"), (char*)MYDNS_RR_DATA_VALUE(rr));
}
/*--- reply_add_srv() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_TXT
	Adds a TXT record to the reply.
	Returns the numeric offset of the start of this record within the reply, or -1 on error.
**************************************************************************************************/
static inline int
reply_add_txt(TASK *t, RR *r) {
  char		*dest = NULL;
  size_t	size = 0;
  size_t	len = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;

  len = MYDNS_RR_DATA_LENGTH(rr);

  if (reply_start_rr(t, r, (char*)r->name, DNS_QTYPE_TXT, rr->ttl, "TXT") < 0)
    return (-1);

  size = len + 1;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size)))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, size);
  *dest++ = len;
  memcpy(dest, MYDNS_RR_DATA_VALUE(rr), len);
  dest += len;
  return (0);
}
/*--- reply_add_txt() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_ADD_OPAQUE
	Adds a generic record with opaque data (for modern record types).
	Treats the data field as raw text/data to be returned as-is.
	Unlike TXT records, does not add a length prefix before the data.
**************************************************************************************************/
static inline int
reply_add_opaque(TASK *t, RR *r, dns_qtype_t qtype, const char *desc) {
  char		*dest = NULL;
  size_t	size = 0;
  size_t	len = 0;
  MYDNS_RR	*rr = (MYDNS_RR *)r->rr;

  len = MYDNS_RR_DATA_LENGTH(rr);

  if (reply_start_rr(t, r, (char*)r->name, qtype, rr->ttl, desc) < 0)
    return (-1);

  size = len;
  r->length += SIZE16 + size;

  if (!(dest = rdata_enlarge(t, SIZE16 + size)))
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  DNS_PUT16(dest, size);
  memcpy(dest, MYDNS_RR_DATA_VALUE(rr), len);
  dest += len;
  return (0);
}
/*--- reply_add_opaque() ------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_PROCESS_RRLIST
	Adds each resource record found in `rrlist' to the reply.
**************************************************************************************************/
static int
reply_process_rrlist(TASK *t, RRLIST *rrlist) {
  register RR *r = NULL;

  if (!rrlist)
    return (0);

  for (r = rrlist->head; r; r = r->next) {
    switch (r->rrtype) {
    case DNS_RRTYPE_SOA:
      if (reply_add_soa(t, r) < 0)
	return (-1);
      break;

    case DNS_RRTYPE_RR:
      {
	MYDNS_RR *rr = (MYDNS_RR *)r->rr;

	if (!rr)
	  break;

	switch (rr->type) {
	case DNS_QTYPE_UNKNOWN:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;

	case DNS_QTYPE_NONE:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;

	case DNS_QTYPE_A:
	  if (reply_add_a(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_NS:
	  if (reply_add_generic_rr(t, r, "NS") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_MD:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_MF:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_CNAME:
	  if (reply_add_generic_rr(t, r, "CNAME") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_SOA:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;

	case DNS_QTYPE_MB:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_MG:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_MR:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NULL:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_WKS:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_PTR:
	  if (reply_add_generic_rr(t, r, "PTR") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_HINFO:
	  if (reply_add_hinfo(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_MINFO:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_MX:
	  if (reply_add_mx(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_TXT:
	  if (reply_add_txt(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_RP:
	  if (reply_add_rp(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_AFSDB:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_X25:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_ISDN:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_RT:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NSAP:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NSAP_PTR:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_SIG:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_KEY:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_PX:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_GPOS:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_AAAA:
	  if (reply_add_aaaa(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_LOC:
	  if (reply_add_loc(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_NXT:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_EID:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NIMLOC:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_SRV:
	  if (reply_add_srv(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_ATMA:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NAPTR:
	  if (reply_add_naptr(t, r) < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_KX:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_CERT:
	  if (reply_add_opaque(t, r, DNS_QTYPE_CERT, "CERT") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_A6:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_DNAME:
	  if (reply_add_opaque(t, r, DNS_QTYPE_DNAME, "DNAME") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_SINK:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_OPT:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_APL:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_DS:
	  if (reply_add_opaque(t, r, DNS_QTYPE_DS, "DS") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_SSHFP:
	  if (reply_add_opaque(t, r, DNS_QTYPE_SSHFP, "SSHFP") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_IPSECKEY:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_RRSIG:
	  if (reply_add_opaque(t, r, DNS_QTYPE_RRSIG, "RRSIG") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_NSEC:
	  if (reply_add_opaque(t, r, DNS_QTYPE_NSEC, "NSEC") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_DNSKEY:
	  if (reply_add_opaque(t, r, DNS_QTYPE_DNSKEY, "DNSKEY") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_DHCID:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_NSEC3:
	  if (reply_add_opaque(t, r, DNS_QTYPE_NSEC3, "NSEC3") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_NSEC3PARAM:
	  if (reply_add_opaque(t, r, DNS_QTYPE_NSEC3PARAM, "NSEC3PARAM") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_TLSA:
	  if (reply_add_opaque(t, r, DNS_QTYPE_TLSA, "TLSA") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_SMIMEA:
	  if (reply_add_opaque(t, r, DNS_QTYPE_SMIMEA, "SMIMEA") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_OPENPGPKEY:
	  if (reply_add_opaque(t, r, DNS_QTYPE_OPENPGPKEY, "OPENPGPKEY") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_SVCB:
	  if (reply_add_opaque(t, r, DNS_QTYPE_SVCB, "SVCB") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_HTTPS:
	  if (reply_add_opaque(t, r, DNS_QTYPE_HTTPS, "HTTPS") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_HIP:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_SPF:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_UINFO:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_UID:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_GID:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_UNSPEC:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_TKEY:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_TSIG:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_IXFR:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpect resource record type - logic problem"));
	  break;

	case DNS_QTYPE_AXFR:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;

	case DNS_QTYPE_MAILB:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_MAILA:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_URI:
	  if (reply_add_opaque(t, r, DNS_QTYPE_URI, "URI") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_CAA:
	  if (reply_add_opaque(t, r, DNS_QTYPE_CAA, "CAA") < 0)
	    return (-1);
	  break;

	case DNS_QTYPE_ANY:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;

	case DNS_QTYPE_TA:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

	case DNS_QTYPE_DLV:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unsupported resource record type"));
	  break;

#if ALIAS_ENABLED
	case DNS_QTYPE_ALIAS:
	  Warnx("%s: %s: %s", desctask(t), mydns_qtype_str(rr->type),
		_("unexpected resource record type - logic problem"));
	  break;
#endif

	}
      }
      break;
    }
  }
  return (0);
}
/*--- reply_process_rrlist() --------------------------------------------------------------------*/


/**************************************************************************************************
	TRUNCATE_RRLIST
	Returns new count of items in this list.
	The TC flag is _not_ set if data was truncated from the ADDITIONAL section.
**************************************************************************************************/
static int
truncate_rrlist(TASK *t, off_t maxpkt, RRLIST *rrlist, datasection_t ds) {
  register RR *rr = NULL;
  register int recs = 0;
#if DEBUG_ENABLED && DEBUG_REPLY
  int orig_recs = rrlist->size;
#endif

  /* Warn about truncated packets, but only if TCP is not enabled.  Most resolvers will try
     TCP if a UDP packet is truncated. */
  if (!tcp_enabled)
    Verbose("%s: %s", desctask(t), _("query truncated"));

  recs = rrlist->size;
  for (rr = rrlist->head; rr; rr = rr->next) {
    if ((off_t)(rr->offset + rr->length) >= maxpkt) {
      recs--;
      if (ds != ADDITIONAL)
	t->hdr.tc = 1;
    } else
      t->rdlen += rr->length;
  }
#if DEBUG_ENABLED && DEBUG_REPLY
  DebugX("reply", 1, _("%s section truncated from %d records to %d records"),
	 reply_datasection_str[ds], orig_recs, recs);
#endif
  return (recs);
}
/*--- truncate_rrlist() -------------------------------------------------------------------------*/


/**************************************************************************************************
	REPLY_CHECK_TRUNCATION
	If this reply would be truncated, removes any RR's that won't fit and sets the truncation flag.
**************************************************************************************************/
static void
reply_check_truncation(TASK *t, int *ancount, int *nscount, int *arcount) {
  size_t maxpkt = (t->protocol == SOCK_STREAM ? DNS_MAXPACKETLEN_TCP : DNS_MAXPACKETLEN_UDP);
  size_t maxrd = maxpkt - (DNS_HEADERSIZE + t->qdlen);

  if (t->rdlen <= maxrd)
    return;

#if DEBUG_ENABLED && DEBUG_REPLY
  DebugX("reply", 1, _("reply_check_truncation() needs to truncate reply (%u) to fit packet max (%u)"),
	 (unsigned int)t->rdlen, (unsigned int)maxrd);
#endif

  /* Loop through an/ns/ar sections, truncating as necessary, and updating counts */
  t->rdlen = 0;
  *ancount = truncate_rrlist(t, maxpkt, &t->an, ANSWER);
  *nscount = truncate_rrlist(t, maxpkt, &t->ns, AUTHORITY);
  *arcount = truncate_rrlist(t, maxpkt, &t->ar, ADDITIONAL);
}
/*--- reply_check_truncation() ------------------------------------------------------------------*/

void
abandon_reply(TASK *t) {
  /* Empty RR lists */
  rrlist_free(&t->an);
  rrlist_free(&t->ns);
  rrlist_free(&t->ar);

  /* Make sure reply is empty */
  t->replylen = 0;
  t->rdlen = 0;
  RELEASE(t->rdata);
}

/**************************************************************************************************
	BUILD_CACHE_REPLY
	Builds reply data from cached answer.
**************************************************************************************************/
void
build_cache_reply(TASK *t) {
  char *dest = t->reply;

  DNS_PUT16(dest, t->id);							/* Query ID */
  DNS_PUT(dest, &t->hdr, SIZE16);						/* Header */
}
/*--- build_cache_reply() -----------------------------------------------------------------------*/


/**************************************************************************************************
	BUILD_REPLY
	Given a task, constructs the reply data.
**************************************************************************************************/
void
build_reply(TASK *t, int want_additional) {
  char	*dest = NULL;
  int	ancount = 0, nscount = 0, arcount = 0;

  /* Add data to ADDITIONAL section */
  if (want_additional) {
    reply_add_additional(t, &t->an);
    reply_add_additional(t, &t->ns);
  }

  /* Sort records where necessary */
  if (t->an.a_records > 1)			/* ANSWER section: Sort A/AAAA records */
    sort_a_recs(t, &t->an, ANSWER);
  if (t->an.mx_records > 1)			/* ANSWER section: Sort MX records */
    sort_mx_recs(t, &t->an, ANSWER);
  if (t->an.srv_records > 1)			/* ANSWER section: Sort SRV records */
    sort_srv_recs(t, &t->an, ANSWER);
  if (t->ar.a_records > 1)			/* AUTHORITY section: Sort A/AAAA records */
    sort_a_recs(t, &t->ar, AUTHORITY);

  /* Build `rdata' containing resource records in ANSWER, AUTHORITY, and ADDITIONAL */
  t->replylen = DNS_HEADERSIZE + t->qdlen + t->rdlen;
  if (reply_process_rrlist(t, &t->an)
      || reply_process_rrlist(t, &t->ns)
      || reply_process_rrlist(t, &t->ar)) {
    abandon_reply(t);
  }

  ancount = t->an.size;
  nscount = t->ns.size;
  arcount = t->ar.size;

  /* Verify reply length */
  reply_check_truncation(t, &ancount, &nscount, &arcount);

  /* Make sure header bits are set correctly */
  t->hdr.qr = 1;
  t->hdr.cd = 0;

  /* Construct the reply */
  t->replylen = DNS_HEADERSIZE + t->qdlen + t->rdlen;
  dest = t->reply = ALLOCATE(t->replylen, char[]);

  DNS_PUT16(dest, t->id);					/* Query ID */
  DNS_PUT(dest, &t->hdr, SIZE16);				/* Header */
  DNS_PUT16(dest, t->qdcount);					/* QUESTION count */
  DNS_PUT16(dest, ancount);					/* ANSWER count */
  DNS_PUT16(dest, nscount);					/* AUTHORITY count */
  DNS_PUT16(dest, arcount);					/* ADDITIONAL count */
  if (t->qdlen && t->qd)
    DNS_PUT(dest, t->qd, t->qdlen);				/* Data for QUESTION section */
  DNS_PUT(dest, t->rdata, t->rdlen);				/* Resource record data */

#if DEBUG_ENABLED && DEBUG_REPLY
  DebugX("reply", 1, _("%s: reply:     id = %u"), desctask(t),
	 t->id);
  DebugX("reply", 1, _("%s: reply:     qr = %u (message is a %s)"), desctask(t),
	 t->hdr.qr, t->hdr.qr ? "response" : "query");
  DebugX("reply", 1, _("%s: reply: opcode = %u (%s)"), desctask(t),
	 t->hdr.opcode, mydns_opcode_str(t->hdr.opcode));
  DebugX("reply", 1, _("%s: reply:     aa = %u (answer %s)"), desctask(t),
	 t->hdr.aa, t->hdr.aa ? "is authoritative" : "not authoritative");
  DebugX("reply", 1, _("%s: reply:     tc = %u (message %s)"), desctask(t),
	 t->hdr.tc, t->hdr.tc ? "truncated" : "not truncated");
  DebugX("reply", 1, _("%s: reply:     rd = %u (%s)"), desctask(t),
	 t->hdr.rd, t->hdr.rd ? "recursion desired" : "no recursion");
  DebugX("reply", 1, _("%s: reply:     ra = %u (recursion %s)"), desctask(t),
	 t->hdr.ra, t->hdr.ra ? "available" : "unavailable");
  DebugX("reply", 1, _("%s: reply:  rcode = %u (%s)"), desctask(t),
	 t->hdr.rcode, mydns_rcode_str(t->hdr.rcode));
  /* escdata(t->reply, t->replylen); */
#endif
}
/*--- build_reply() -----------------------------------------------------------------------------*/

/* vi:set ts=3: */
/* NEED_PO */
