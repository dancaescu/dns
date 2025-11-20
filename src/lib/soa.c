/**************************************************************************************************
	$Id: soa.c,v 1.65 2005/12/18 19:16:41 bboy Exp $

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
#include <time.h>

char *mydns_soa_table_name = NULL;
char *mydns_soa_where_clause = NULL;
char *mydns_cf_soa_table_name = NULL;
char *mydns_cf_default_ns = NULL;
char *mydns_cf_default_mbox = NULL;

char *mydns_soa_active_types[] = { (char*)"Y", (char*)"N" };

/* Optional columns */
int mydns_soa_use_active = 0;
int mydns_soa_use_xfer = 0;
int mydns_soa_use_update_acl = 0;
int mydns_soa_use_recursive = 0;

/* Make this nonzero to enable debugging within this source file */
#define	DEBUG_LIB_SOA	1

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

static int
mydns_soa_origin_exists(MYDNS_SOA *first, const char *origin) {
  for (; first; first = first->next) {
    if (mydns_cf_name_equals(first->origin, origin))
      return 1;
  }
  return 0;
}

static void
mydns_soa_ensure_trailing_dot(char *name, size_t size) {
  size_t len;

  if (!name || !*name || size < 2)
    return;

  len = strlen(name);
  if (!len)
    return;
  if (len >= size)
    len = size - 1;
  if (name[len - 1] == '.')
    return;
  if (len >= size - 1)
    return;
  name[len++] = '.';
  name[len] = '\0';
}

static MYDNS_SOA *
mydns_soa_build_from_cloudflare(SQL_ROW row) {
  MYDNS_SOA *soa;
  uint32_t serial = 0;
  size_t len;

  if (!row[0] || !row[1])
    return NULL;

  soa = (MYDNS_SOA *)ALLOCATE(sizeof(MYDNS_SOA), MYDNS_SOA);
  memset(soa, 0, sizeof(MYDNS_SOA));

  soa->id = atou(row[0]);
  strncpy(soa->origin, row[1], sizeof(soa->origin) - 1);
  mydns_soa_ensure_trailing_dot(soa->origin, sizeof(soa->origin));

  if (mydns_cf_default_ns && *mydns_cf_default_ns)
    strncpy(soa->ns, mydns_cf_default_ns, sizeof(soa->ns) - 1);
  else
    snprintf(soa->ns, sizeof(soa->ns), "ns.%s", soa->origin);

  if (mydns_cf_default_mbox && *mydns_cf_default_mbox)
    strncpy(soa->mbox, mydns_cf_default_mbox, sizeof(soa->mbox) - 1);
  else
    snprintf(soa->mbox, sizeof(soa->mbox), "hostmaster.%s", soa->origin);

  if (row[2])
    serial = atou(row[2]);

  soa->serial = serial ? serial : (uint32_t)time(NULL);
  soa->refresh = DNS_DEFAULT_REFRESH;
  soa->retry = DNS_DEFAULT_RETRY;
  soa->expire = DNS_DEFAULT_EXPIRE;
  soa->minimum = DNS_DEFAULT_MINIMUM;
  soa->ttl = DNS_DEFAULT_TTL;
  soa->recursive = 0;

  if (soa->ttl < soa->minimum)
    soa->ttl = soa->minimum;

  len = strlen(soa->ns);
  if (len && soa->ns[len-1] != '.') {
    strncat(soa->ns, ".", sizeof(soa->ns) - len - 1);
    strncat(soa->ns, soa->origin, sizeof(soa->ns) - strlen(soa->ns) - 1);
  }
  len = strlen(soa->mbox);
  if (len && soa->mbox[len-1] != '.') {
    strncat(soa->mbox, ".", sizeof(soa->mbox) - len - 1);
    strncat(soa->mbox, soa->origin, sizeof(soa->mbox) - strlen(soa->mbox) - 1);
  }

  return soa;
}

static void
mydns_soa_append_cloudflare(SQL *sqlConn, MYDNS_SOA **first, MYDNS_SOA **last, const char *origin) {
  SQL_RES *res;
  SQL_ROW row;
  char normalized_origin[DNS_MAXNAMELEN + 1];
  char *query = NULL;
  size_t querylen;

  if (!mydns_cf_enabled || !mydns_cf_soa_table_name || !origin || !first || !last)
    return;

  mydns_cf_copy_name(normalized_origin, sizeof(normalized_origin), origin);
  if (!normalized_origin[0])
    return;

  querylen = sql_build_query(&query,
			     "SELECT id,name,COALESCE(UNIX_TIMESTAMP(last_synced), UNIX_TIMESTAMP(NOW())) "
			     "FROM %s WHERE name='%s'",
			     mydns_cf_soa_table_name,
			     normalized_origin);
  if (!query)
    return;

  res = sql_query(sqlConn, query, querylen);
  RELEASE(query);
  if (!res)
    return;

  while ((row = sql_getrow(res, NULL))) {
    MYDNS_SOA *newsoa;

    if (!row[1] || mydns_soa_origin_exists(*first, row[1]))
      continue;

    newsoa = mydns_soa_build_from_cloudflare(row);
    if (!newsoa)
      continue;

    if (!*first)
      *first = newsoa;
    if (*last)
      (*last)->next = newsoa;
    *last = newsoa;
  }

  sql_free(res);
}

void
mydns_soa_get_active_types(SQL *sqlConn) {
  SQL_RES	*res;
  SQL_ROW	row;
  int		querylen;
  char 		*query;

  char		*YES = (char*)"Y";
  char		*NO = (char*)"N";

  querylen = sql_build_query(&query, "SELECT DISTINCT(active) FROM %s LIMIT 1", mydns_soa_table_name);

  if (!(res = sql_query(sqlConn, query, querylen))) {
    RELEASE(query);
    return;
  }

#if DEBUG_ENABLED && DEBUG_LIB_SOA
  {
    int numresults = sql_num_rows(res);
    DebugX("lib-soa", 1, _("SOA get active types: %d row%s: %s"), numresults, S(numresults), query);
  }
#endif

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
	   || !strcasecmp(VAL, "1") ) { YES = STRDUP(VAL); continue; }
    if (   !strcasecmp(VAL, "no")
	   || !strcasecmp(VAL, "n")
	   || !strcasecmp(VAL, "false")
	   || !strcasecmp(VAL, "f")
	   || !strcasecmp(VAL, "inactive")
	   || !strcasecmp(VAL, "i")
	   || !strcasecmp(VAL, "off")
	   || !strcasecmp(VAL, "0") ) { NO = STRDUP(VAL); continue; }
  }

  sql_free(res);

  mydns_soa_active_types[0] = YES;
  mydns_soa_active_types[1] = NO;
}

/**************************************************************************************************
	MYDNS_SOA_COUNT
	Returns the number of zones in the soa table.
**************************************************************************************************/
long
mydns_soa_count(SQL *sqlConn) {
  return sql_count(sqlConn, "SELECT COUNT(*) FROM %s", mydns_soa_table_name);
}
/*--- mydns_soa_count() -------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SET_SOA_TABLE_NAME
**************************************************************************************************/
void
mydns_set_soa_table_name(const char *name) {
  RELEASE(mydns_soa_table_name);
  if (!name)
    mydns_soa_table_name = STRDUP(MYDNS_SOA_TABLE);
  else
    mydns_soa_table_name = STRDUP(name);
}
/*--- mydns_set_soa_table_name() ----------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SET_SOA_WHERE_CLAUSE
**************************************************************************************************/
void
mydns_set_soa_where_clause(const char *where) {
  if (where && strlen(where)) {
    mydns_soa_where_clause = STRDUP(where);
  }
}
/*--- mydns_set_soa_where_clause() --------------------------------------------------------------*/

void
mydns_set_cf_soa_table_name(const char *name) {
  RELEASE(mydns_cf_soa_table_name);
  if (name && *name)
    mydns_cf_soa_table_name = STRDUP(name);
  else
    mydns_cf_soa_table_name = NULL;
}

void
mydns_set_cf_default_ns(const char *name) {
  RELEASE(mydns_cf_default_ns);
  if (name && *name)
    mydns_cf_default_ns = STRDUP(name);
  else
    mydns_cf_default_ns = NULL;
}

void
mydns_set_cf_default_mbox(const char *name) {
  RELEASE(mydns_cf_default_mbox);
  if (name && *name)
    mydns_cf_default_mbox = STRDUP(name);
  else
    mydns_cf_default_mbox = NULL;
}


/**************************************************************************************************
	MYDNS_SOA_PARSE
**************************************************************************************************/
static
#if !PROFILING
inline
#endif
MYDNS_SOA *
mydns_soa_parse(SQL_ROW row) {
  MYDNS_SOA *rv;
  int len;

  rv = (MYDNS_SOA *)ALLOCATE(sizeof(MYDNS_SOA), MYDNS_SOA);

  rv->next = NULL;

  rv->id = atou(row[0]);
  strncpy(rv->origin, row[1], sizeof(rv->origin)-1);
  mydns_soa_ensure_trailing_dot(rv->origin, sizeof(rv->origin));
  strncpy(rv->ns, row[2], sizeof(rv->ns)-1);
  if (!rv->ns[0])
    snprintf(rv->ns, sizeof(rv->ns), "ns.%s", rv->origin);
  strncpy(rv->mbox, row[3], sizeof(rv->mbox)-1);
  if (!rv->mbox[0])
    snprintf(rv->mbox, sizeof(rv->mbox), "hostmaster.%s", rv->origin);
  rv->serial = atou(row[4]);
  rv->refresh = atou(row[5]);
  rv->retry = atou(row[6]);
  rv->expire = atou(row[7]);
  rv->minimum = atou(row[8]);
  rv->ttl = atou(row[9]);

  { int ridx = MYDNS_SOA_NUMFIELDS;
    ridx += (mydns_soa_use_active)?1:0;
    rv->recursive = ((mydns_soa_use_recursive)?GETBOOL(row[ridx]):0);
  }

  /* If 'ns' or 'mbox' don't end in a dot, append the origin */
  len = strlen(rv->ns);
  if (rv->ns[len-1] != '.') {
    strncat(rv->ns, ".", sizeof(rv->ns) - len - 1);
    strncat(rv->ns, rv->origin, sizeof(rv->ns) - len - 2);
  }
  len = strlen(rv->mbox);
  if (rv->mbox[len-1] != '.') {
    strncat(rv->mbox, ".", sizeof(rv->mbox) - len - 1);
    strncat(rv->mbox, rv->origin, sizeof(rv->mbox) - len - 2);
  }

  /* Make sure TTL for SOA is at least the minimum */
  if (rv->ttl < rv->minimum)
    rv->ttl = rv->minimum;

  return (rv);
}
/*--- mydns_soa_parse() -------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SOA_DUP
	Create a duplicate copy of the record.
	Make and return a copy of a MYDNS_SOA record.  If 'recurse' is specified, copies all records
	in the list.
**************************************************************************************************/
MYDNS_SOA *
mydns_soa_dup(MYDNS_SOA *start, int recurse) {
  register MYDNS_SOA *first = NULL, *last = NULL, *soa, *s, *tmp;

  for (s = start; s; s = tmp) {
    tmp = s->next;

    soa = (MYDNS_SOA *)ALLOCATE(sizeof(MYDNS_SOA), MYDNS_SOA);

    soa->id = s->id;
    strncpy(soa->origin, s->origin, sizeof(soa->origin)-1);
    strncpy(soa->ns, s->ns, sizeof(soa->ns)-1);
    strncpy(soa->mbox, s->mbox, sizeof(soa->mbox)-1);
    soa->serial = s->serial;
    soa->refresh = s->refresh;
    soa->retry = s->retry;
    soa->expire = s->expire;
    soa->minimum = s->minimum;
    soa->ttl = s->ttl;
    soa->recursive = s->recursive;
    soa->next = NULL;
    if (recurse) {
      if (!first) first = soa;
      if (last) last->next = soa;
      last = soa;
    } else
      return (soa);
  }
  return (first);
}
/*--- mydns_soa_dup() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SOA_SIZE
**************************************************************************************************/
#if !PROFILING
inline
#endif
size_t
mydns_soa_size(MYDNS_SOA *first) {
  register MYDNS_SOA *p;
  register size_t size = 0;

  for (p = first; p; p = p->next)
    size += sizeof(MYDNS_SOA);

  return (size);
}
/*--- mydns_soa_size() --------------------------------------------------------------------------*/


/**************************************************************************************************
	_MYDNS_SOA_FREE
	Frees the pointed-to structure.	Don't call this function directly, call the macro.
**************************************************************************************************/
#if !PROFILING
inline
#endif
void
_mydns_soa_free(MYDNS_SOA *first) {
  register MYDNS_SOA *p, *tmp;

  for (p = first; p; p = tmp) {
    tmp = p->next;
    RELEASE(p);
  }
}
/*--- mydns_soa_free() --------------------------------------------------------------------------*/


/**************************************************************************************************
	MYDNS_SOA_LOAD
	Returns 0 on success or nonzero if an error occurred.
**************************************************************************************************/
int
mydns_soa_load(SQL *sqlConn, MYDNS_SOA **rptr, const char *origin) {
  MYDNS_SOA		*first = NULL, *last = NULL;
  size_t		querylen;
  char			*query;
  SQL_RES		*res;
  SQL_ROW		row;
  const char		*c;
#ifdef DN_COLUMN_NAMES
  int			originlen = strlen(origin);
#endif

#if DEBUG_ENABLED && DEBUG_LIB_SOA
  DebugX("lib-soa", 1, _("mydns_soa_load(%s)"), origin);
#endif

  if (rptr) *rptr = NULL;

  /* Verify args */
  if (!sqlConn || !origin || !rptr) {
    errno = EINVAL;
    return (-1);
  }

  /* We're not escaping 'origin', so check it for illegal type chars */
  for (c = origin; *c; c++)
    if (SQL_BADCHAR(*c))
      return (0);

#ifdef DN_COLUMN_NAMES
  if (origin[originlen - 1] == '.')
    origin[originlen - 1] = '\0';				/* Remove dot from origin for DN */
  else
    originlen = 0;
#endif

  /* Construct query */
  querylen = sql_build_query(&query,
			     "SELECT "MYDNS_SOA_FIELDS"%s%s FROM %s WHERE origin='%s'%s%s;",
			     (mydns_soa_use_active ? ",active" : ""),
			     (mydns_soa_use_recursive ? ",recursive" : ""),
			     mydns_soa_table_name, origin,
			     (mydns_soa_where_clause)? " AND " : "",
			     (mydns_soa_where_clause)? mydns_soa_where_clause : "");

#ifdef DN_COLUMN_NAMES
  if (originlen)
    origin[originlen - 1] = '.';				/* Re-add dot to origin for DN */
#endif

  /* Submit query */
  if (!(res = sql_query(sqlConn, query, querylen)))
    return (-1);

#if DEBUG_ENABLED && DEBUG_LIB_SOA
  {
    int numresults = sql_num_rows(res);

    DebugX("lib-soa", 1, _("SOA query: %d row%s: %s"), numresults, S(numresults), query);
  }
#endif

  RELEASE(query);

  /* Add results to list */
  while ((row = sql_getrow(res, NULL))) {
    MYDNS_SOA *new;

#if DEBUG_ENABLED && DEBUG_LIB_SOA
    DebugX("lib-soa", 1, _("SOA query: use_soa_active=%d soa_active=%s,%d"), mydns_soa_use_active,
	   (mydns_soa_use_active)?row[MYDNS_SOA_NUMFIELDS]:"<undef>",
	   (mydns_soa_use_active)?GETBOOL(row[MYDNS_SOA_NUMFIELDS]):-1);
    DebugX("lib-soa", 1, _("SOA query: id=%s, origin=%s, ns=%s, mbox=%s, serial=%s, refresh=%s, "
			   "retry=%s, expire=%s, minimum=%s, ttl=%s"),
	   row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9]);
    { int ridx = MYDNS_SOA_NUMFIELDS;
      ridx += (mydns_soa_use_active)?1:0;
      DebugX("lib-soa", 1, _("Soa query: recursive = %s"),
	     (mydns_soa_use_recursive)?row[ridx++]:_("not recursing"));
    }
#endif

    if (mydns_soa_use_active && row[MYDNS_SOA_NUMFIELDS] && !GETBOOL(row[MYDNS_SOA_NUMFIELDS]))
      continue;

    new = mydns_soa_parse(row);
    if (!first) first = new;
    if (last) last->next = new;
    last = new;
  }

  sql_free(res);
  mydns_soa_append_cloudflare(sqlConn, &first, &last, origin);

  *rptr = first;
  return (0);
}
/*--- mydns_soa_load() --------------------------------------------------------------------------*/

/* vi:set ts=3: */
