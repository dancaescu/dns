/**************************************************************************************************
	$Id: rr.c,v 1.65 2005/04/29 16:10:27 bboy Exp $

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

#include "mydns.h"

#define __MYDNS_RR_NAME(__rrp)			((__rrp)->_name)
#define __MYDNS_RR_DATA(__rrp)			((__rrp)->_data)
#define __MYDNS_RR_DATA_LENGTH(__rrp)		((__rrp)->_data.len)
#define __MYDNS_RR_DATA_VALUE(__rrp)		((__rrp)->_data.value)

char *mydns_rr_table_name = NULL;
char *mydns_rr_where_clause = NULL;
char *mydns_cf_rr_table_name = NULL;
int mydns_cf_enabled = 0;

size_t mydns_rr_data_length = DNS_DATALEN;

/* Optional columns */
int mydns_rr_extended_data = 0;
int mydns_rr_use_active = 0;
int mydns_rr_use_stamp = 0;
int mydns_rr_use_serial = 0;

char *mydns_rr_active_types[] = { (char*)"Y", (char*)"N", (char*)"D" };

/* Make this nonzero to enable debugging within this source file */
#define	DEBUG_LIB_RR	1

static void
mydns_cf_copy_name(char *dst, size_t dstlen, const char *src) {
  size_t len;

  if (!dstlen) return;

  if (!src) {
    dst[0] = '\0';
    return;
  }

  strncpy(dst, src, dstlen - 1);
  dst[dstlen - 1] = '\0';

  len = strlen(dst);
  while (len && dst[len-1] == '.') {
    dst[len-1] = '\0';
    len--;
  }
}

static int
mydns_cf_name_equals(const char *left, const char *right) {
  char norm_left[DNS_MAXNAMELEN + 1];
  char norm_right[DNS_MAXNAMELEN + 1];

  if (!left || !right) return 0;

  mydns_cf_copy_name(norm_left, sizeof(norm_left), left);
  mydns_cf_copy_name(norm_right, sizeof(norm_right), right);

  if (!norm_left[0] && !norm_right[0]) return 1;

  return !strcasecmp(norm_left, norm_right);
}

static void
mydns_cf_relative_name(char *dst, size_t dstlen, const char *fqdn, const char *zone) {
  size_t name_len, zone_len;
  char norm_name[DNS_MAXNAMELEN + 1];
  char norm_zone[DNS_MAXNAMELEN + 1];

  if (!dstlen) return;

  mydns_cf_copy_name(norm_name, sizeof(norm_name), fqdn);
  mydns_cf_copy_name(norm_zone, sizeof(norm_zone), zone);

  name_len = strlen(norm_name);
  zone_len = strlen(norm_zone);

  dst[0] = '\0';

  if (!zone_len) {
    strncpy(dst, norm_name, dstlen - 1);
    dst[dstlen - 1] = '\0';
    return;
  }

  if (!name_len) {
    dst[0] = '\0';
    return;
  }

  if (name_len == zone_len && !strcasecmp(norm_name, norm_zone)) {
    dst[0] = '\0';
    return;
  }

  if (name_len > zone_len + 1 &&
      norm_name[name_len - zone_len - 1] == '.' &&
      !strncasecmp(&norm_name[name_len - zone_len], norm_zone, zone_len)) {
    size_t rel_len = name_len - zone_len - 1;
    if (rel_len >= dstlen)
      rel_len = dstlen - 1;
    strncpy(dst, norm_name, rel_len);
    dst[rel_len] = '\0';
    return;
  }

  strncpy(dst, norm_name, dstlen - 1);
  dst[dstlen - 1] = '\0';
}

static int
mydns_cf_rr_name_matches(const char *filter, const char *candidate) {
  char norm_filter[DNS_MAXNAMELEN + 1];
  char norm_candidate[DNS_MAXNAMELEN + 1];

  if (!filter) return 1;

  mydns_cf_copy_name(norm_filter, sizeof(norm_filter), filter);
  mydns_cf_copy_name(norm_candidate, sizeof(norm_candidate), candidate);

  if (norm_filter[0] == '@' && !norm_filter[1])
    norm_filter[0] = '\0';

  if (!norm_filter[0])
    return !norm_candidate[0];

  /* First try exact match */
  if (!strcasecmp(norm_filter, norm_candidate))
    return 1;

  /* If candidate contains wildcard, use wildcard matching */
  if (strchr(norm_candidate, '*') || strchr(norm_candidate, '?'))
    return wildcard_match(norm_candidate, norm_filter);

  return 0;
}

#if DEBUG_ENABLED
void *
__mydns_rr_assert_pointer(void *ptr, const char *fieldname, const char *filename, int linenumber) {
#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_assert_pointer() called for field=%s from %s:%d"),
	 fieldname, filename, linenumber);
#endif
  if (ptr != NULL) return ptr;
  DebugX("lib-rr", 1, _("%s Pointer is NULL at %s:%d"),
	 fieldname, filename, linenumber);
  abort();
  return ptr;
}
#endif

void
mydns_rr_get_active_types(SQL *sqlConn) {
  SQL_RES	*res;
  SQL_ROW	row;
  int 		querylen;
  char		*query;

  char		*YES = (char*)"Y";
  char		*NO = (char*)"N";
  char		*DELETED = (char*)"D";

  querylen = sql_build_query(&query, "SELECT DISTINCT(active) FROM %s", mydns_rr_table_name);

  if (!(res = sql_query(sqlConn, query, querylen))) return;

  RELEASE(query);

  while ((row = sql_getrow(res, NULL))) {
    char *VAL = row[0];
    if (   !strcasecmp(VAL, "yes")
	   || !strcasecmp(VAL, "y")
	   || !strcasecmp(VAL, "true")
	   || !strcasecmp(VAL, "t")
	   || !strcasecmp(VAL, "active")
	   || !strcasecmp(VAL, "a")
	   || !strcasecmp(VAL, "on")
	   || !strcmp(VAL, "1") ) { YES = STRDUP(VAL); continue; }
    if (   !strcasecmp(VAL, "no")
	   || !strcasecmp(VAL, "n")
	   || !strcasecmp(VAL, "false")
	   || !strcasecmp(VAL, "f")
	   || !strcasecmp(VAL, "inactive")
	   || !strcasecmp(VAL, "i")
	   || !strcasecmp(VAL, "off")
	   || !strcmp(VAL, "0") ) { NO = STRDUP(VAL); continue; }
    if (   !strcasecmp(VAL, "d")
	   || !strcasecmp(VAL, "deleted")
	   || !strcmp(VAL, "2") ) { DELETED = STRDUP(VAL); continue; }
  }

  sql_free(res);

  mydns_rr_active_types[0] = YES;
  mydns_rr_active_types[1] = NO;
  mydns_rr_active_types[2] = DELETED;
}

/**************************************************************************************************
	MYDNS_RR_COUNT
	Returns the number of records in the rr table.
**************************************************************************************************/
long
mydns_rr_count(SQL *sqlConn) {
  return sql_count(sqlConn, "SELECT COUNT(*) FROM %s", mydns_rr_table_name);
}
/*--- mydns_rr_count() --------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SET_RR_TABLE_NAME
**************************************************************************************************/
void
mydns_set_rr_table_name(const char *name) {
  RELEASE(mydns_rr_table_name);
  if (!name)
    mydns_rr_table_name = STRDUP(MYDNS_RR_TABLE);
  else
    mydns_rr_table_name = STRDUP(name);
}
/*--- mydns_set_rr_table_name() -----------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SET_RR_WHERE_CLAUSE
**************************************************************************************************/
void
mydns_set_rr_where_clause(const char *where) {
  if (where && strlen(where)) {
    mydns_rr_where_clause = STRDUP(where);
  }
}
/*--- mydns_set_rr_where_clause() ---------------------------------------------------------------*/

void
mydns_set_cf_rr_table_name(const char *name) {
  RELEASE(mydns_cf_rr_table_name);
  if (name && *name)
    mydns_cf_rr_table_name = STRDUP(name);
  else
    mydns_cf_rr_table_name = NULL;
}

void
mydns_update_cloudflare_state(void) {
  mydns_cf_enabled = (mydns_cf_rr_table_name && *mydns_cf_rr_table_name &&
		      mydns_cf_soa_table_name && *mydns_cf_soa_table_name);
}


/**************************************************************************************************
	MYDNS_RR_GET_TYPE
**************************************************************************************************/
inline dns_qtype_t
mydns_rr_get_type(char *type) {
  register char *c;

  for (c = type; *c; c++)
    *c = toupper(*c);

  switch (type[0]) {
  case 'A':
    if (!type[1])
      return DNS_QTYPE_A;

    if (type[1] == 'A' && type[2] == 'A' && type[3] == 'A' && !type[4])
      return DNS_QTYPE_AAAA;

#if ALIAS_ENABLED
    if (type[1] == 'L' && type[2] == 'I' && type[3] == 'A' && type[4] == 'S' && !type[5])
      return DNS_QTYPE_ALIAS;
#endif
    break;

  case 'C':
    if (type[1] == 'N' && type[2] == 'A' && type[3] == 'M' && type[4] == 'E' && !type[5])
      return DNS_QTYPE_CNAME;
    break;

  case 'H':
    if (type[1] == 'I' && type[2] == 'N' && type[3] == 'F' && type[4] == 'O' && !type[5])
      return DNS_QTYPE_HINFO;
    break;

  case 'M':
    if (type[1] == 'X' && !type[2])
      return DNS_QTYPE_MX;
    break;

  case 'N':
    if (type[1] == 'S' && !type[2])
      return DNS_QTYPE_NS;
    if (type[1] == 'A' && type[2] == 'P' && type[3] == 'T' && type[4] == 'R' && !type[5])
      return DNS_QTYPE_NAPTR;
    break;

  case 'T':
    if (type[1] == 'X' && type[2] == 'T' && !type[3])
      return DNS_QTYPE_TXT;
    break;

  case 'P':
    if (type[1] == 'T' && type[2] == 'R' && !type[3])
      return DNS_QTYPE_PTR;
    break;

  case 'R':
    if (type[1] == 'P' && !type[2])
      return DNS_QTYPE_RP;
    break;

  case 'S':
    if (type[1] == 'R' && type[2] == 'V' && !type[3])
      return DNS_QTYPE_SRV;
    break;
  }
  return 0;
}
/*--- mydns_rr_get_type() -----------------------------------------------------------------------*/

static const char *
mydns_rr_type_to_string(dns_qtype_t type) {
  switch (type) {
  case DNS_QTYPE_A: return "A";
  case DNS_QTYPE_AAAA: return "AAAA";
  case DNS_QTYPE_CNAME: return "CNAME";
  case DNS_QTYPE_HINFO: return "HINFO";
  case DNS_QTYPE_MX: return "MX";
  case DNS_QTYPE_NAPTR: return "NAPTR";
  case DNS_QTYPE_NS: return "NS";
  case DNS_QTYPE_PTR: return "PTR";
  case DNS_QTYPE_SOA: return "SOA";
  case DNS_QTYPE_SRV: return "SRV";
  case DNS_QTYPE_TXT: return "TXT";
#if ALIAS_ENABLED
  case DNS_QTYPE_ALIAS: return "ALIAS";
#endif
  case DNS_QTYPE_ANY: return NULL;
  default:
    return NULL;
  }
}


/**************************************************************************************************
	MYDNS_RR_PARSE_RP
	RP contains two names in 'data' -- the mbox and the txt.
	NUL-terminate mbox and fill 'rp_txt' with the txt part of the record.
**************************************************************************************************/
static inline int
mydns_rr_parse_rp(const char *origin, MYDNS_RR *rr) {
  char *copy = NULL, *mbox = NULL, *txt = NULL, *save = NULL;
  char *canon_mbox = NULL, *canon_txt = NULL, *merged = NULL;

  copy = STRDUP(__MYDNS_RR_DATA_VALUE(rr));
  if (!copy)
    return (-1);

  mbox = strtok_r(copy, " \t", &save);
  txt = strtok_r(NULL, " \t", &save);
  if (!mbox) {
    RELEASE(copy);
    return (-1);
  }
  if (!txt || !*txt)
    txt = (char*)".";

  canon_mbox = mydns_rr_append_origin(mbox, (char*)origin);
  canon_txt = mydns_rr_append_origin(txt, (char*)origin);

  ASPRINTF(&merged, "%s %s", canon_mbox, canon_txt);

  RELEASE(__MYDNS_RR_DATA_VALUE(rr));
  __MYDNS_RR_DATA_VALUE(rr) = merged;
  __MYDNS_RR_DATA_LENGTH(rr) = strlen(merged);

  if (canon_mbox != mbox)
    RELEASE(canon_mbox);
  if (canon_txt != txt)
    RELEASE(canon_txt);
  RELEASE(copy);
  if (txt != (char*)".")
    ; /* nothing special */

  return (0);
}
/*--- mydns_rr_parse_rp() -----------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_RR_PARSE_SRV
	SRV records contain two unsigned 16-bit integers in the "data" field before the target,
	'srv_weight' and 'srv_port' - parse them and make "data" contain only the target.  Also, make
	sure 'aux' fits into 16 bits, clamping values above 65535.
**************************************************************************************************/
static inline int
mydns_rr_parse_srv(const char *origin, MYDNS_RR *rr) {
  char *copy = NULL, *weight = NULL, *port = NULL, *target = NULL, *save = NULL;
  unsigned int weight_val = 0, port_val = 0;
  char *canon_target = NULL, *merged = NULL;

  copy = STRDUP(__MYDNS_RR_DATA_VALUE(rr));
  if (!copy)
    return (-1);

  weight = strtok_r(copy, " \t", &save);
  port = strtok_r(NULL, " \t", &save);
  target = strtok_r(NULL, " \t", &save);

  if (!weight || !port || !target) {
    RELEASE(copy);
    return (-1);
  }

  weight_val = (unsigned int)atou(weight);
  port_val = (unsigned int)atou(port);

  if (rr->aux > 65535)
    rr->aux = 65535;

  canon_target = mydns_rr_append_origin(target, (char*)origin);
  ASPRINTF(&merged, "%u %u %s", weight_val & 0xFFFF, port_val & 0xFFFF, canon_target);

  RELEASE(__MYDNS_RR_DATA_VALUE(rr));
  __MYDNS_RR_DATA_VALUE(rr) = merged;
  __MYDNS_RR_DATA_LENGTH(rr) = strlen(merged);

  if (canon_target != target)
    RELEASE(canon_target);
  RELEASE(copy);
  return (0);
}
/*--- mydns_rr_parse_srv() ----------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_RR_PARSE_NAPTR
	Returns 0 on success, -1 on error.
**************************************************************************************************/
static inline int
mydns_rr_parse_naptr(const char *origin, MYDNS_RR *rr) {
  char *tmp = NULL, *p = NULL, *data_copy = NULL;
  int ok = -1;

  (void)origin;
  data_copy = STRNDUP(__MYDNS_RR_DATA_VALUE(rr), __MYDNS_RR_DATA_LENGTH(rr));
  if (!data_copy)
    return (-1);
  p = data_copy;

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  RELEASE(tmp);

  ok = 0;

cleanup:
  if (tmp)
    RELEASE(tmp);
  RELEASE(data_copy);
  return ok;
}
/*--- mydns_rr_parse_naptr() --------------------------------------------------------------------*/

static inline int
mydns_rr_parse_txt(const char *origin, MYDNS_RR *rr) {
  int datalen = __MYDNS_RR_DATA_LENGTH(rr);
  char *data = __MYDNS_RR_DATA_VALUE(rr);

  if (datalen > DNS_MAXTXTLEN) return (-1);

  while (datalen > 0) {
    size_t elemlen = strlen(data);
    if (elemlen > DNS_MAXTXTELEMLEN) return (-1);
    data = &data[elemlen+1];
    datalen -= elemlen + 1;
  }
  
  return 0;
}

static char *
__mydns_rr_append(char *s1, char *s2) {
  int s1len = strlen(s1);
  int s2len = strlen(s2);
  int newlen = s1len;
  char *name;
  if (s1len) newlen += 1;
  newlen += s2len;

  name = ALLOCATE(newlen+1, char[]);
  if (s1len) { strncpy(name, s1, s1len); name[s1len] = '.'; s1len += 1; }
  strncpy(&name[s1len], s2, s2len);
  name[newlen] = '\0';
  return name;
}

char *
mydns_rr_append_origin(char *str, char *origin) {
  char *res = ((!*str || LASTCHAR(str) != '.')
	       ?__mydns_rr_append(str, origin)
	       :str);
  return res;
}

void
mydns_rr_name_append_origin(MYDNS_RR *rr, char *origin) {
  char *res = mydns_rr_append_origin(__MYDNS_RR_NAME(rr), origin);
  if (__MYDNS_RR_NAME(rr) != res) RELEASE(__MYDNS_RR_NAME(rr));
  __MYDNS_RR_NAME(rr) = res;
}
      
void
mydns_rr_data_append_origin(MYDNS_RR *rr, char *origin) {
  char *res = mydns_rr_append_origin(__MYDNS_RR_DATA_VALUE(rr), origin);
  if (__MYDNS_RR_DATA_VALUE(rr) != res) RELEASE(__MYDNS_RR_DATA_VALUE(rr));
  __MYDNS_RR_DATA_VALUE(rr) = res;
  __MYDNS_RR_DATA_LENGTH(rr) = strlen(__MYDNS_RR_DATA_VALUE(rr));
}
      
/**************************************************************************************************
	_MYDNS_RR_FREE
	Frees the pointed-to structure.	Don't call this function directly, call the macro.
**************************************************************************************************/
void
_mydns_rr_free(MYDNS_RR *first) {
  register MYDNS_RR *p, *tmp;

  for (p = first; p; p = tmp) {
    tmp = p->next;
    RELEASE(p->stamp);
    RELEASE(__MYDNS_RR_NAME(p));
    RELEASE(__MYDNS_RR_DATA_VALUE(p));
    RELEASE(p);
  }
}
/*--- _mydns_rr_free() --------------------------------------------------------------------------*/

MYDNS_RR *
mydns_rr_build(uint32_t id,
	       uint32_t zone,
	       dns_qtype_t type,
	       dns_class_t class,
	       uint32_t aux,
	       uint32_t ttl,
	       char *active,
#if USE_PGSQL
	       timestamp *stamp,
#else
	       MYSQL_TIME *stamp,
#endif
	       uint32_t serial,
	       char *name,
	       char *data,
	       uint16_t	datalen,
	       const char *origin) {
  MYDNS_RR	*rr = NULL;
  uint32_t	namelen;

#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_build(): called for id=%d, zone=%d, type=%d, class=%d, aux=%d, "
			"ttl=%d, active='%s', stamp=%p, serial=%d, name='%s', data=%p, datalen=%d, origin='%s'"),
	 id, zone, type, class, aux, ttl, active, stamp, serial,
	 (name)?name:_("<NULL>"), data, datalen, origin);
#endif

  if ((namelen = (name)?strlen(name):0) > DNS_MAXNAMELEN) {
    /* Name exceeds permissable length - should report error */
    goto PARSEFAILED;
  }

  rr = (MYDNS_RR *)ALLOCATE(sizeof(MYDNS_RR), MYDNS_RR);
  memset(rr, '\0', sizeof(MYDNS_RR));
  rr->next = NULL;

  rr->id = id;
  rr->zone = zone;

  __MYDNS_RR_NAME(rr) = ALLOCATE(namelen+1, char[]);
  memset(__MYDNS_RR_NAME(rr), 0, namelen+1);
  if (name) strncpy(__MYDNS_RR_NAME(rr), name, namelen);

  /* Should store length and buffer rather than handle as a string */
  __MYDNS_RR_DATA_LENGTH(rr) = datalen;
  __MYDNS_RR_DATA_VALUE(rr) = ALLOCATE(datalen+1, char[]);
  memcpy(__MYDNS_RR_DATA_VALUE(rr), data, datalen);

  rr->class = class;
  rr->aux = aux;
  rr->ttl = ttl;
  rr->type = type;
#if ALIAS_ENABLED
  if (rr->type == DNS_QTYPE_ALIAS) {
    rr->type = DNS_QTYPE_A;
    rr->alias = 1;
  } else
    rr->alias = 0;
#endif

  /* Find a constant value so we do not have to allocate or free this one */
  if (active) {
    int i;
    for (i = 0; i < 3; i++) {
      if (!strcasecmp(mydns_rr_active_types[i], active)) { active = mydns_rr_active_types[i]; break; }
    }
  }
  rr->active = active;
  rr->stamp = stamp;
  rr->serial = serial;

  switch (rr->type) {

  case DNS_QTYPE_TXT:
    if (mydns_rr_parse_txt(origin, rr) < 0) {
      goto PARSEFAILED;
    }
    break;

  case DNS_QTYPE_NAPTR:
    /* Populate special fields for NAPTR records */
    if (mydns_rr_parse_naptr(origin, rr) < 0) {
      goto PARSEFAILED;
    }
    break;

  case DNS_QTYPE_RP:
    if (mydns_rr_parse_rp(origin, rr) < 0) {
      goto PARSEFAILED;
    }
    break;

  case DNS_QTYPE_SRV:
    if (mydns_rr_parse_srv(origin, rr) < 0) {
      goto PARSEFAILED;
    }
    break;

  case DNS_QTYPE_CNAME:
  case DNS_QTYPE_MX:
  case DNS_QTYPE_NS:

    /* Append origin to data if it's not there for these types: */
    if (origin) {
      datalen = __MYDNS_RR_DATA_LENGTH(rr);
#ifdef DN_COLUMN_NAMES
      datalen += 1;
      __MYDNS_RR_DATA_LENGTH(rr) = datalen;
      __MYDNS_RR_DATA_VALUE(rr) = REALLOCATE(__MYDNS_RR_DATA_VALUE(rr), datalen+1, char[]);
      /* Just append dot for DN */
      ((char*)__MYDNS_RR_DATA_VALUE(rr))[datalen-1] = '.';
#else
      if (datalen && ((char*)__MYDNS_RR_DATA_VALUE(rr))[datalen-1] != '.') {
	datalen = datalen + 1 + strlen(origin);
	__MYDNS_RR_DATA_VALUE(rr) = REALLOCATE(__MYDNS_RR_DATA_VALUE(rr), datalen+1, char[]);
	((char*)__MYDNS_RR_DATA_VALUE(rr))[__MYDNS_RR_DATA_LENGTH(rr)] = '.';
	memcpy(&((char*)__MYDNS_RR_DATA_VALUE(rr))[__MYDNS_RR_DATA_LENGTH(rr)+1], origin, strlen(origin));
	__MYDNS_RR_DATA_LENGTH(rr) = datalen;
      }
#endif
      ((char*)__MYDNS_RR_DATA_VALUE(rr))[__MYDNS_RR_DATA_LENGTH(rr)] = '\0';
    }
    break;
  default:
    break;
  }

#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_build(): returning result=%p"), rr);
#endif
  return (rr);

 PARSEFAILED:
  mydns_rr_free(rr);
  return (NULL);
}

/**************************************************************************************************
	MYDNS_RR_PARSE
	Given the SQL results with RR data, populates and returns a matching MYDNS_RR structure.
	Returns NULL on error.
**************************************************************************************************/
inline MYDNS_RR *
mydns_rr_parse(SQL_ROW row, unsigned long *lengths, const char *origin) {
  dns_qtype_t	type;
  char		*active = NULL;
#if USE_PGSQL
  timestamp	*stamp = NULL;
#else
  MYSQL_TIME	*stamp = NULL;
#endif
  uint32_t	serial = 0;
  int		ridx = MYDNS_RR_NUMFIELDS;
  char		*data;
  uint16_t	datalen;
  MYDNS_RR	*rr;

#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_parse(): called for origin %s"), origin);
#endif

/* #60 */
//if (!(type = mydns_rr_get_type(row[6]))) {
  if (!row[6] || !(type = mydns_rr_get_type(row[6]))) {
    /* Ignore unknown RR type(s) */
    return (NULL);
  }

  data = row[3];
  datalen = lengths[3];
  if (mydns_rr_extended_data) {
    if (lengths[ridx]) {
      char *newdata = ALLOCATE(datalen + lengths[ridx], char[]);
      memcpy(newdata, data, datalen);
      memcpy(&newdata[datalen], row[ridx], lengths[ridx]);
      datalen += lengths[ridx];
      data = newdata;
    }
    ridx++;
  }

  /* Copy storage? */
  if (mydns_rr_use_active) active = row[ridx++];
  if (mydns_rr_use_stamp) {
#if USE_PGSQL
    /* Copy storage? */
    stamp = row[ridx++];
#else
    stamp = (MYSQL_TIME*)ALLOCATE(sizeof(MYSQL_TIME), MYSQL_TIME);
    memcpy(stamp, row[ridx++], sizeof(MYSQL_TIME));
#endif
  }
  if (mydns_rr_use_serial && row[ridx]) {
    serial = atou(row[ridx++]);
  }

  rr = mydns_rr_build(atou(row[0]),
		      atou(row[1]),
		      type,
		      DNS_CLASS_IN,
		      atou(row[4]),
		      atou(row[5]),
		      active,
		      stamp,
		      serial,
		      row[2],
		      data,
		      datalen,
		      origin);

  if (mydns_rr_extended_data && lengths[MYDNS_RR_NUMFIELDS]) RELEASE(data);

  return (rr);
}
/*--- mydns_rr_parse() --------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_RR_DUP
	Make and return a copy of a MYDNS_RR record.  If 'recurse' is specified, copies all records
	in the RRset.
**************************************************************************************************/
MYDNS_RR *
mydns_rr_dup(MYDNS_RR *start, int recurse) {
  register MYDNS_RR *first = NULL, *last = NULL, *rr, *s, *tmp;

  for (s = start; s; s = tmp) {
    tmp = s->next;

    rr = (MYDNS_RR *)ALLOCATE(sizeof(MYDNS_RR), MYDNS_RR);

    memset(rr, '\0', sizeof(MYDNS_RR));
    rr->id = s->id;
    rr->zone = s->zone;
    __MYDNS_RR_NAME(rr) = STRDUP(__MYDNS_RR_NAME(s));
    rr->type = s->type;
    rr->class = s->class;
    __MYDNS_RR_DATA_LENGTH(rr) = __MYDNS_RR_DATA_LENGTH(s);
    __MYDNS_RR_DATA_VALUE(rr) = ALLOCATE(__MYDNS_RR_DATA_LENGTH(s)+1, char[]);
    memcpy(__MYDNS_RR_DATA_VALUE(rr), __MYDNS_RR_DATA_VALUE(s), __MYDNS_RR_DATA_LENGTH(s));
    ((char*)__MYDNS_RR_DATA_VALUE(rr))[__MYDNS_RR_DATA_LENGTH(rr)] = '\0';
    rr->aux = s->aux;
    rr->ttl = s->ttl;
#if ALIAS_ENABLED
    rr->alias = s->alias;
#endif

    rr->active = s->active;
    if (s->stamp) {
#if USE_PGSQL
      rr->stamp = s->stamp;
#else
      rr->stamp = (MYSQL_TIME*)ALLOCATE(sizeof(MYSQL_TIME), MYSQL_TIME);
      memcpy(rr->stamp, s->stamp, sizeof(MYSQL_TIME));
#endif
    } else
      rr->stamp = NULL;
    rr->serial = s->serial;

    rr->next = NULL;
    if (recurse) {
      if (!first) first = rr;
      if (last) last->next = rr;
      last = rr;
    } else
      return (rr);
  }
  return (first);
}
/*--- mydns_rr_dup() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_RR_SIZE
**************************************************************************************************/
inline size_t
mydns_rr_size(MYDNS_RR *first) {
  register MYDNS_RR *p;
  register size_t size = 0;

  for (p = first; p; p = p->next) {
    size += sizeof(MYDNS_RR)
      + (strlen(__MYDNS_RR_NAME(p)) + 1)
      + (__MYDNS_RR_DATA_LENGTH(p) + 1);
#if USE_PGSQL
#else
    size += sizeof(MYSQL_TIME);
#endif
  }    

  return (size);
}
/*--- mydns_rr_size() ---------------------------------------------------------------------------*/

int
mydns_rr_srv_values(const MYDNS_RR *rr, uint16_t *priority, uint16_t *weight, uint16_t *port, char **target) {
  unsigned int w = 0, p = 0;
  char buf[DNS_MAXNAMELEN + 1];

  if (!rr || !MYDNS_RR_DATA_VALUE(rr))
    return (-1);
  if (sscanf((char*)MYDNS_RR_DATA_VALUE(rr), "%u %u %255s", &w, &p, buf) != 3)
    return (-1);
  if (priority)
    *priority = (uint16_t)(rr->aux & 0xFFFF);
  if (weight)
    *weight = (uint16_t)(w & 0xFFFF);
  if (port)
    *port = (uint16_t)(p & 0xFFFF);
  if (target)
    *target = STRDUP(buf);
  return (0);
}

int
mydns_rr_rp_values(const MYDNS_RR *rr, char **mbox, char **txt) {
  char boxbuf[DNS_MAXNAMELEN + 1];
  char txtbuf[DNS_MAXNAMELEN + 1] = ".";
  int fields;

  if (!rr || !MYDNS_RR_DATA_VALUE(rr))
    return (-1);

  fields = sscanf((char*)MYDNS_RR_DATA_VALUE(rr), "%255s %255s", boxbuf, txtbuf);
  if (fields < 1)
    return (-1);

  if (mbox)
    *mbox = STRDUP(boxbuf);
  if (txt)
    *txt = STRDUP(txtbuf);
  return (0);
}

int
mydns_rr_naptr_values(const MYDNS_RR *rr,
		      uint16_t *order, uint16_t *pref,
		      char **flags, char **service, char **regex, char **replacement) {
  char *copy = NULL, *p = NULL, *tmp = NULL;
  char *flags_local = NULL, *service_local = NULL;
  char *regex_local = NULL, *replacement_local = NULL;
  int rv = -1;

  if (!rr || !MYDNS_RR_DATA_VALUE(rr))
    return (-1);

  copy = STRDUP(MYDNS_RR_DATA_VALUE(rr));
  if (!copy)
    return (-1);
  p = copy;

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  if (order)
    *order = (uint16_t)atou(tmp);
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &tmp))
    goto cleanup;
  if (pref)
    *pref = (uint16_t)atou(tmp);
  RELEASE(tmp);

  if (!strsep_quotes2(&p, &flags_local))
    goto cleanup;

  if (!strsep_quotes2(&p, &service_local))
    goto cleanup;

  if (!strsep_quotes2(&p, &regex_local))
    goto cleanup;

  if (!strsep_quotes2(&p, &replacement_local))
    goto cleanup;

  if (flags) {
    *flags = flags_local;
    flags_local = NULL;
  }
  if (service) {
    *service = service_local;
    service_local = NULL;
  }
  if (regex) {
    *regex = regex_local;
    regex_local = NULL;
  }
  if (replacement) {
    *replacement = replacement_local;
    replacement_local = NULL;
  }

  rv = 0;

cleanup:
  if (flags_local)
    RELEASE(flags_local);
  if (service_local)
    RELEASE(service_local);
  if (regex_local)
    RELEASE(regex_local);
  if (replacement_local)
    RELEASE(replacement_local);
  if (tmp)
    RELEASE(tmp);
  RELEASE(copy);
  return rv;
}


/**************************************************************************************************
	MYDNS_RR_LOAD
	Returns 0 on success or nonzero if an error occurred.
	If "name" is NULL, all resource records for the zone will be loaded.
**************************************************************************************************/
char *
mydns_rr_columns() {
  char		*columns = NULL;
  size_t	columnslen = 0;

  columnslen = sql_build_query(&columns, MYDNS_RR_FIELDS"%s%s%s%s",
			       /* Optional columns */
			       (mydns_rr_extended_data ? ",edata" : ""),
			       (mydns_rr_use_active ? ",active" : ""),
			       (mydns_rr_use_stamp  ? ",stamp"  : ""),
			       (mydns_rr_use_serial ? ",serial" : ""));
  return columns;
}

char *
mydns_rr_prepare_query(uint32_t zone, dns_qtype_t type, const char *name, const char *origin,
		       const char *active, const char *columns, const char *filter) {
  size_t	querylen;
  char		*query = NULL;
  char		*namequery = NULL;
  const char	*wheretype;
  const char	*cp;
#ifdef DN_COLUMN_NAMES
  int		originlen = origin ? strlen(origin) : 0;
  int		namelen = name ? strlen(name) : 0;
#endif

#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_prepare_query(zone=%u, type='%s', name='%s', origin='%s')"),
	 zone, mydns_qtype_str(type), name ?: _("NULL"), origin ?: _("NULL"));
#endif

  /* Get the type='XX' part of the WHERE clause */
  switch (type)	{
#if ALIAS_ENABLED
  case DNS_QTYPE_A:		wheretype = " AND (type='A' OR type='ALIAS')"; break;
#else
  case DNS_QTYPE_A:		wheretype = " AND type='A'"; break;
#endif
  case DNS_QTYPE_AAAA:		wheretype = " AND type='AAAA'"; break;
  case DNS_QTYPE_CNAME:	        wheretype = " AND type='CNAME'"; break;
  case DNS_QTYPE_HINFO:	        wheretype = " AND type='HINFO'"; break;
  case DNS_QTYPE_MX:		wheretype = " AND type='MX'"; break;
  case DNS_QTYPE_NAPTR:	        wheretype = " AND type='NAPTR'"; break;
  case DNS_QTYPE_NS:		wheretype = " AND type='NS'"; break;
  case DNS_QTYPE_PTR:		wheretype = " AND type='PTR'"; break;
  case DNS_QTYPE_SOA:		wheretype = " AND type='SOA'"; break;
  case DNS_QTYPE_SRV:		wheretype = " AND type='SRV'"; break;
  case DNS_QTYPE_TXT:		wheretype = " AND type='TXT'"; break;
  case DNS_QTYPE_ANY:		wheretype = ""; break;
  default:
    errno = EINVAL;
    return (NULL);
  }

  /* Make sure 'name' and 'origin' (if present) are valid */
  if (name) {
    for (cp = name; *cp; cp++)
      if (SQL_BADCHAR(*cp))
	return (NULL);
  }
  if (origin) {
    for (cp = origin; *cp; cp++)
      if (SQL_BADCHAR(*cp))
	return (NULL);
  }

#ifdef DN_COLUMN_NAMES
  /* Remove dot from origin and name for DN */
  if (originlen && origin[originlen - 1] == '.')
    origin[originlen-1] = '\0';
  else
    originlen = 0;

  if (name) {
    if (namelen && name[namelen - 1] == '.')
      name[namelen-1] = '\0';
    else
      namelen = 0;
  }
#endif

  /* Construct query */
  if (name) {
    if (origin) {
      if (!name[0])
	sql_build_query(&namequery, "(name='' OR name='%s')", origin);
      else {
#ifdef DN_COLUMN_NAMES
	sql_build_query(&namequery, "name='%s'", name);
#else
	sql_build_query(&namequery, "(name='%s' OR name='%s.%s')", name, name, origin);
#endif
      }
    }
    else
      sql_build_query(&namequery, "name='%s'", name);
  }

#ifdef DN_COLUMN_NAMES
  if (originlen)
    origin[originlen - 1] = '.';				/* Re-add dot to origin for DN */

  if (name) {
    if (namelen)
      name[namelen - 1] = '.';
  }
#endif

  querylen = sql_build_query(&query, "SELECT %s FROM %s WHERE "
#ifdef DN_COLUMN_NAMES
			     "zone_id=%u%s"
#else
			     "zone=%u%s"
#endif
			     " AND deleted_at IS NULL"
			     "%s%s"
			     "%s%s%s"
			     "%s%s"
			     "%s%s"
			     "%s",

			     columns,

			     /* Fixed data */
			     mydns_rr_table_name,
			     zone, wheretype,

			     /* Name based query */
			     (namequery)? " AND " : "",
			     (namequery)? namequery : "",

			     /* Optional check for active value */
			     (mydns_rr_use_active)? " AND active='" : "",
			     (mydns_rr_use_active)? active : "",
			     (mydns_rr_use_active)? "'" : "",

			     /* Optional where clause for rr table */
			     (mydns_rr_where_clause)? " AND " : "",
			     (mydns_rr_where_clause)? mydns_rr_where_clause : "",

			     /* Apply additional filter if requested */
			     (filter)? " AND " : "",
			     (filter)? filter : "",

			     /* Optional sorting */
			     (mydns_rr_use_stamp)? " ORDER BY stamp DESC" : "");

  RELEASE(namequery);

  return (query);
}
			 
static int __mydns_rr_do_load(SQL *sqlConn, MYDNS_RR **rptr, const char *query, const char *origin) {
  MYDNS_RR	*first = NULL, *last = NULL;
  char		*cp;
  SQL_RES	*res;
  SQL_ROW	row;
  unsigned long *lengths;


#if DEBUG_ENABLED && DEBUG_LIB_RR
  DebugX("lib-rr", 1, _("mydns_rr_do_load(query='%s', origin='%s')"), query, origin ? origin : _("NULL"));
#endif

  if (rptr) *rptr = NULL;

  /* Verify args */
  if (!sqlConn || !rptr || !query) {
    errno = EINVAL;
    return (-1);
  }

  /* Submit query */
  if (!(res = sql_query(sqlConn, query, strlen(query))))
    return (-1);

#if DEBUG_ENABLED && DEBUG_LIB_RR
  {
    int numresults = sql_num_rows(res);

    DebugX("lib-rr", 1, _("RR query: %d row%s: %s"), numresults, S(numresults), query);
  }
#endif

  RELEASE(query);

  /* Add results to list */
  while ((row = sql_getrow(res, &lengths))) {
    MYDNS_RR *new;

    if (!(new = mydns_rr_parse(row, lengths, origin)))
      continue;

    /* Always trim origin from name (XXX: Why? When did I add this?) */
    /* Apparently removing this code breaks RRs where the name IS the origin */
    /* But trim only where the name is exactly the origin */
    if (origin && (cp = strstr(__MYDNS_RR_NAME(new), origin)) && !(cp - __MYDNS_RR_NAME(new)))
      *cp = '\0';

    if (!first) first = new;
    if (last) last->next = new;
    last = new;
  }

  *rptr = first;
  sql_free(res);
  return (0);
}

static void
mydns_rr_append_cloudflare(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
			   dns_qtype_t type,
			   const char *name, const char *origin,
			   const char *active, const char *filter) {
  SQL_RES	*res;
  SQL_ROW	row;
  char		zone_clause[64];
  char		origin_clause[DNS_MAXNAMELEN * 2];
  char		type_clause[64];
  char		normalized_origin[DNS_MAXNAMELEN + 1];
  const char	*type_name = NULL;
  char		*query = NULL;
  size_t	querylen;
  MYDNS_RR	*tail;

  if (!mydns_cf_enabled || !mydns_cf_rr_table_name || !mydns_cf_soa_table_name)
    return;
  if (!sqlConn || !rptr)
    return;
  if (filter && *filter)
    return;
  if (active && strcasecmp(active, mydns_rr_active_types[0]))
    return;

  normalized_origin[0] = '\0';
  if (origin && *origin)
    mydns_cf_copy_name(normalized_origin, sizeof(normalized_origin), origin);

  if (!zone && !normalized_origin[0])
    return;

  if (type != DNS_QTYPE_ANY) {
    type_name = mydns_rr_type_to_string(type);
    if (!type_name)
      return;
    snprintf(type_clause, sizeof(type_clause), " AND r.record_type='%s'", type_name);
  } else
    type_clause[0] = '\0';

  if (zone)
    snprintf(zone_clause, sizeof(zone_clause), " AND r.zone_id=%u", zone);
  else
    zone_clause[0] = '\0';

  if (!zone && normalized_origin[0])
    snprintf(origin_clause, sizeof(origin_clause), " AND z.name='%s'", normalized_origin);
  else
    origin_clause[0] = '\0';

  querylen = sql_build_query(&query,
			     "SELECT r.id,r.zone_id,r.record_type,r.name,r.content,"
			     "COALESCE(NULLIF(r.ttl,0),%u) AS ttl,"
			     "COALESCE(r.priority,0) AS priority,"
			     "z.name "
			     "FROM %s AS r "
			     "JOIN %s AS z ON z.id=r.zone_id "
			     "WHERE 1=1%s%s%s",
			     DNS_DEFAULT_TTL,
			     mydns_cf_rr_table_name,
			     mydns_cf_soa_table_name,
			     zone_clause,
			     origin_clause,
			     type_clause);
  if (!query)
    return;

  res = sql_query(sqlConn, query, querylen);
  RELEASE(query);
  if (!res)
    return;

  tail = *rptr;
  while (tail && tail->next)
    tail = tail->next;

  while ((row = sql_getrow(res, NULL))) {
    const char	*row_zone;
    dns_qtype_t	row_type;
    uint32_t	ttl;
    uint32_t	aux;
    const char	*data;
    size_t	datalen;
    char	relative_name[DNS_MAXNAMELEN + 1];
    MYDNS_RR	*newrr;

    if (!row[0] || !row[1] || !row[2] || !row[3] || !row[4])
      continue;

    row_zone = row[7];
    if (!row_zone || !*row_zone)
      continue;

    if (!zone && normalized_origin[0] && !mydns_cf_name_equals(origin, row_zone))
      continue;

    mydns_cf_relative_name(relative_name, sizeof(relative_name), row[3], row_zone);

    if (!mydns_cf_rr_name_matches(name, relative_name))
      continue;

    row_type = mydns_rr_get_type(row[2]);
    if (!row_type)
      continue;

    ttl = atou(row[5]);
    if (ttl == 0 || ttl == 1)
      ttl = DNS_DEFAULT_TTL;

    aux = row[6] ? atou(row[6]) : 0;

    data = row[4];
    datalen = strlen(data);
    if (datalen > DNS_MAXDATALEN || datalen > 0xFFFF)
      continue;

    /* Cloudflare records need trailing dots for domain name types */
    /* This prevents recursive appending of the origin */
    char data_with_dot[DNS_MAXDATALEN + 2];
    int needs_dot = 0;

    /* Check if this record type contains a domain name that needs a trailing dot */
    switch (row_type) {
      case DNS_QTYPE_CNAME:
      case DNS_QTYPE_MX:
      case DNS_QTYPE_NS:
      case DNS_QTYPE_PTR:
      case DNS_QTYPE_SRV:
      case DNS_QTYPE_NAPTR:
        needs_dot = 1;
        break;
      default:
        needs_dot = 0;
        break;
    }

    /* Add trailing dot if needed and not already present */
    if (needs_dot && datalen > 0 && data[datalen-1] != '.') {
      if (datalen + 1 < sizeof(data_with_dot)) {
        snprintf(data_with_dot, sizeof(data_with_dot), "%s.", data);
        data = data_with_dot;
        datalen++;
      }
    }

    newrr = mydns_rr_build(atou(row[0]),
			   atou(row[1]),
			   row_type,
			   DNS_CLASS_IN,
			   aux,
			   ttl,
			   mydns_rr_active_types[0],
			   NULL,
			   0,
			   relative_name,
			   (char*)data,
			   (uint16_t)datalen,
			   row_zone);
    if (!newrr)
      continue;

    if (!*rptr)
      *rptr = newrr;
    else
      tail->next = newrr;
    tail = newrr;
  }

  sql_free(res);
}

static int
__mydns_rr_count(SQL *sqlConn, uint32_t zone,
		 dns_qtype_t type,
		 const char *name, const char *origin, const char *active, const char *filter) {
  char		*query = NULL;
  int		result;

  SQL_RES	*res;
  SQL_ROW	row;

  query = mydns_rr_prepare_query(zone, type, name, origin, active, (char*)"COUNT(*)", filter);

  if (!query || !(res = sql_query(sqlConn, query, strlen(query)))) {
    WarnSQL(sqlConn, _("error processing count with filter %s"), filter);
    return (-1);
  }

  RELEASE(query);

  if ((row = sql_getrow(res, NULL)))
    result = atoi(row[0]);
  else
    result = 0;

  sql_free(res);

  return result;
}

static int 
__mydns_rr_load(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
		dns_qtype_t type,
		const char *name, const char *origin, const char *active, const char *filter) {
  char		*query = NULL;
  int		res;
  char		*columns = NULL;

  columns = mydns_rr_columns();

  query = mydns_rr_prepare_query(zone, type, name, origin, active, columns, filter);

  RELEASE(columns);

  res = __mydns_rr_do_load(sqlConn, rptr, query, origin);

  if (res == 0)
    mydns_rr_append_cloudflare(sqlConn, rptr, zone, type, name, origin, active, filter);

  return res;
}

int mydns_rr_load_all(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
		      dns_qtype_t type,
		      const char *name, const char *origin) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, NULL, NULL);
}

int mydns_rr_load_active(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
			 dns_qtype_t type,
			 const char *name, const char *origin) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[0], NULL);
}

int mydns_rr_load_inactive(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
			   dns_qtype_t type,
			   const char *name, const char *origin) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[1], NULL);
}

int mydns_rr_load_deleted(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
			  dns_qtype_t type,
			  const char *name, const char *origin) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[2], NULL);
}

int mydns_rr_count_all(SQL *sqlConn, uint32_t zone,
		       dns_qtype_t type,
		       const char *name, const char *origin) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[0], NULL);
}

int mydns_rr_count_active(SQL *sqlConn, uint32_t zone,
			  dns_qtype_t type,
			  const char *name, const char *origin) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[0], NULL);
}

int mydns_rr_count_inactive(SQL *sqlConn, uint32_t zone,
			    dns_qtype_t type,
			    const char *name, const char *origin) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[1], NULL);
}

int mydns_rr_count_deleted(SQL *sqlConn, uint32_t zone,
			   dns_qtype_t type,
			   const char *name, const char *origin) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[2], NULL);
}


int mydns_rr_load_all_filtered(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
			       dns_qtype_t type,
			       const char *name, const char *origin, const char *filter) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, NULL, filter);
}

int mydns_rr_load_active_filtered(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
				  dns_qtype_t type,
				  const char *name, const char *origin, const char *filter) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[0], filter);
}

int mydns_rr_load_inactive_filtered(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
				    dns_qtype_t type,
				    const char *name, const char *origin, const char *filter) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[1], filter);
}

int mydns_rr_load_deleted_filtered(SQL *sqlConn, MYDNS_RR **rptr, uint32_t zone,
				   dns_qtype_t type,
				   const char *name, const char *origin, const char *filter) {

  return __mydns_rr_load(sqlConn, rptr, zone, type, name, origin, mydns_rr_active_types[2], filter);
}

int mydns_rr_count_all_filtered(SQL *sqlConn, uint32_t zone,
				dns_qtype_t type,
				const char *name, const char *origin, const char *filter) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[0], filter);
}

int mydns_rr_count_active_filtered(SQL *sqlConn, uint32_t zone,
				   dns_qtype_t type,
				   const char *name, const char *origin, const char *filter) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[0], filter);
}

int mydns_rr_count_inactive_filtered(SQL *sqlConn, uint32_t zone,
				     dns_qtype_t type,
				     const char *name, const char *origin, const char *filter) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[1], filter);
}

int mydns_rr_count_deleted_filtered(SQL *sqlConn, uint32_t zone,
				    dns_qtype_t type,
				    const char *name, const char *origin, const char *filter) {

  return __mydns_rr_count(sqlConn, zone, type, name, origin, mydns_rr_active_types[2], filter);
}

/*--- mydns_rr_load() ---------------------------------------------------------------------------*/

/* vi:set ts=3: */
