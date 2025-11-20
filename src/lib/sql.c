/**************************************************************************************************
	$Id: sql.c,v 1.22 2005/04/20 16:40:25 bboy Exp $

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

#if !USE_PGSQL
#include <mysql/errmsg.h>
#endif

SQL *sql;						/* Global SQL connection information */

/* Saved connection information for reconnecting */
static char *_sql_user = NULL;
static char *_sql_password = NULL;
static char *_sql_host = NULL;
static char *_sql_database = NULL;

#if !USE_PGSQL
#define MYSQL_MAX_HOSTS SQL_MAX_DB_HOSTS

typedef enum {
  MYSQL_HOST_POLICY_SEQUENTIAL = 0,
  MYSQL_HOST_POLICY_ROUND_ROBIN,
  MYSQL_HOST_POLICY_LEAST_USED
} mysql_host_policy_t;

typedef struct {
  const char *host;
  int index;
} mysql_candidate_t;

static char *mysql_host_entries[MYSQL_MAX_HOSTS];
static unsigned long mysql_host_use_count[MYSQL_MAX_HOSTS];
static size_t mysql_host_count = 0;
static mysql_host_policy_t mysql_host_policy = MYSQL_HOST_POLICY_SEQUENTIAL;
static size_t mysql_round_robin_cursor = 0;

static mysql_host_policy_t mysql_parse_policy(const char *policy);
static void mysql_clear_host_entries(void);
static void mysql_remember_success(int index);
static size_t mysql_build_candidate_order(size_t *order);
static size_t mysql_prepare_candidates(const char *preferred, mysql_candidate_t *candidates);
static SQL *mysql_connect_candidates(const char *user, const char *password,
				     const char *database, const char *preferred,
				     int *used_index, char **used_host);
#endif

const char *
sql_active_host(void) {
  return _sql_host;
}

void
sql_configure_hosts(const char **hosts, size_t count, const char *policy) {
#if USE_PGSQL
  (void)hosts;
  (void)count;
  (void)policy;
#else
  size_t i;

  mysql_clear_host_entries();
  mysql_host_policy = mysql_parse_policy(policy);
  mysql_round_robin_cursor = 0;

  if (!hosts)
    return;

  for (i = 0; i < count && mysql_host_count < MYSQL_MAX_HOSTS; i++) {
    const char *value = hosts[i];
    size_t n;

    if (!value || !*value)
      continue;

    for (n = 0; n < mysql_host_count; n++) {
      if (!strcasecmp(mysql_host_entries[n], value))
	break;
    }
    if (n < mysql_host_count)
      continue;

    mysql_host_entries[mysql_host_count] = STRDUP(value);
    mysql_host_use_count[mysql_host_count] = 0;
    mysql_host_count++;
  }
#endif
}

#if !USE_PGSQL
static mysql_host_policy_t
mysql_parse_policy(const char *policy) {
  if (!policy || !*policy)
    return MYSQL_HOST_POLICY_SEQUENTIAL;

  if (!strcasecmp(policy, "round-robin") || !strcasecmp(policy, "roundrobin") || !strcasecmp(policy, "rr"))
    return MYSQL_HOST_POLICY_ROUND_ROBIN;
  if (!strcasecmp(policy, "least-used") || !strcasecmp(policy, "least") || !strcasecmp(policy, "least_used"))
    return MYSQL_HOST_POLICY_LEAST_USED;
  if (strcasecmp(policy, "sequential") != 0)
    Warnx(_("Unknown db-host-policy '%s', defaulting to sequential"), policy);
  return MYSQL_HOST_POLICY_SEQUENTIAL;
}

static void
mysql_clear_host_entries(void) {
  size_t i;

  for (i = 0; i < mysql_host_count; i++) {
    RELEASE(mysql_host_entries[i]);
    mysql_host_entries[i] = NULL;
    mysql_host_use_count[i] = 0;
  }
  mysql_host_count = 0;
}

static void
mysql_remember_success(int index) {
  if (index >= 0 && (size_t)index < mysql_host_count)
    mysql_host_use_count[index]++;
}

static size_t
mysql_build_candidate_order(size_t *order) {
  size_t i;

  if (!mysql_host_count)
    return 0;

  for (i = 0; i < mysql_host_count; i++)
    order[i] = i;

  switch (mysql_host_policy) {
  case MYSQL_HOST_POLICY_SEQUENTIAL:
    break;

  case MYSQL_HOST_POLICY_ROUND_ROBIN:
    {
      size_t start = mysql_round_robin_cursor % mysql_host_count;
      size_t idx;

      for (i = 0; i < mysql_host_count; i++) {
	idx = (start + i) % mysql_host_count;
	order[i] = idx;
      }
      mysql_round_robin_cursor = (start + 1) % mysql_host_count;
    }
    break;

  case MYSQL_HOST_POLICY_LEAST_USED:
    for (i = 0; i < mysql_host_count; i++) {
      size_t j;
      for (j = i + 1; j < mysql_host_count; j++) {
	if (mysql_host_use_count[order[j]] < mysql_host_use_count[order[i]]) {
	  size_t tmp = order[i];
	  order[i] = order[j];
	  order[j] = tmp;
	}
      }
    }
    break;
  }

  return mysql_host_count;
}

static size_t
mysql_prepare_candidates(const char *preferred, mysql_candidate_t *candidates) {
  size_t count = 0;

  if (mysql_host_count) {
    size_t order[MYSQL_MAX_HOSTS];
    size_t order_len = mysql_build_candidate_order(order);
    size_t i;

    for (i = 0; i < order_len; i++) {
      candidates[count].host = mysql_host_entries[order[i]];
      candidates[count].index = (int)order[i];
      count++;
    }
  } else if (preferred && *preferred) {
    candidates[count].host = preferred;
    candidates[count].index = -1;
    count++;
  } else {
    candidates[count].host = NULL;
    candidates[count].index = -1;
    count++;
  }

  return count;
}

static char *
mysql_extract_host(const char *input, unsigned int *port_out) {
  const char *start = input;
  const char *end = NULL;
  unsigned int port = 0;

  if (!input || !*input) {
    if (port_out)
      *port_out = 0;
    return NULL;
  }

  if (input[0] == '[') {
    const char *closing = strchr(input, ']');
    if (closing) {
      start = input + 1;
      end = closing;
      if (closing[1] == ':')
	port = (unsigned int)atoi(closing + 2);
    } else {
      end = input + strlen(input);
    }
  } else {
    const char *colon = strrchr(input, ':');
    if (colon && strchr(colon + 1, ':') == NULL) {
      end = colon;
      if (colon[1])
	port = (unsigned int)atoi(colon + 1);
    } else {
      end = input + strlen(input);
    }
  }

  if (!end || end < start)
    end = start + strlen(start);

  {
    size_t len = (size_t)(end - start);
    char *buf = ALLOCATE(len + 1, char[]);
    memcpy(buf, start, len);
    buf[len] = '\0';
    if (port_out)
      *port_out = port;
    return buf;
  }
}

static SQL *
mysql_connect_candidates(const char *user, const char *password,
			 const char *database, const char *preferred,
			 int *used_index, char **used_host) {
  mysql_candidate_t candidates[MYSQL_MAX_HOSTS + 1];
  size_t candidate_count = mysql_prepare_candidates(preferred, candidates);
  size_t i;

  if (used_index)
    *used_index = -1;
  if (used_host)
    *used_host = NULL;

  for (i = 0; i < candidate_count; i++) {
    char *hostbuf = NULL;
    unsigned int port = 0;
    const char *connect_host = candidates[i].host;
    SQL *conn = NULL;
    const char *display = candidates[i].host;

    if (connect_host && *connect_host)
      hostbuf = mysql_extract_host(connect_host, &port);
    if (!hostbuf)
      hostbuf = connect_host ? STRDUP(connect_host) : NULL;

    conn = ALLOCATE(sizeof(*conn), MYSQL);
    if (!mysql_init(conn)) {
      Err(_("Unable to allocate MySQL data structure"));
    }
#if MYSQL_VERSION_ID > 32349
    mysql_options(conn, MYSQL_READ_DEFAULT_GROUP, "client");
#endif
    if (mysql_real_connect(conn,
			   (hostbuf && *hostbuf) ? hostbuf : NULL,
			   user, password, database, port, NULL, 0)) {
      if (hostbuf)
	RELEASE(hostbuf);
      if (used_host) {
	if (display && *display)
	  *used_host = STRDUP(display);
	else
	  *used_host = STRDUP("localhost");
      }
      if (used_index)
	*used_index = candidates[i].index;
      return conn;
    }

    Warnx(_("Unable to connect to MySQL host %s: %s"),
	  (display && *display) ? display : _("(default)"),
	  mysql_error(conn));
    mysql_close(conn);
    if (hostbuf)
      RELEASE(hostbuf);
  }

  return NULL;
}
#endif

#if !USE_PGSQL
static int
mysql_should_retry(unsigned int errcode) {
  switch (errcode) {
  case CR_SERVER_GONE_ERROR:
  case CR_SERVER_LOST:
#ifdef CR_SERVER_LOST_EXTENDED
  case CR_SERVER_LOST_EXTENDED:
#endif
    return 1;
  default:
    return 0;
  }
}

static int
sql_retry_connection(SQL **sqlConnPtr) {
  if (!sqlConnPtr || !*sqlConnPtr)
    return 0;
  if (*sqlConnPtr != sql)
    return 0;

  sql_reopen();
  if (!sql)
    return 0;
  *sqlConnPtr = sql;
  return 1;
}
#endif

/**************************************************************************************************
	SQL_OPEN
	Connect to the database.  Errors fatal.
**************************************************************************************************/
void
sql_open(const char *user, const char *password, const char *host, const char *database) {
#if USE_PGSQL
  char *portp = NULL;
  unsigned int port = 0;
  char *host2 = NULL;
#endif

  /* Save connection information so that we can reconnect if necessary */
  if (_sql_user) RELEASE(_sql_user);
  if (_sql_password) RELEASE(_sql_password);
  if (_sql_host) RELEASE(_sql_host);
  if (_sql_database) RELEASE(_sql_database);
  _sql_user = user ? STRDUP(user) : NULL;
  _sql_password = password ? STRDUP(password) : NULL;
  _sql_host = host ? STRDUP(host) : NULL;
  _sql_database = database ? STRDUP(database) : NULL;

#if USE_PGSQL
  if (host != NULL) {
    host2 = STRDUP(host);

    if ((portp = strchr(host2, ':')) != NULL) {
      port = atoi(portp + 1);
      *portp = '\0';
      portp = portp + 1;
    }
  }
#endif

#if USE_PGSQL
  char *portp2;
//char *host2 = NULL;

  sql = PQsetdbLogin(host2 ? host2 : host, portp, NULL, NULL, database, user, password);
  if (PQstatus(sql) == CONNECTION_BAD) {
    char *errmsg = PQerrorMessage(sql), *c, *out = NULL;

    /* Save the first error message so that the user gets the error message they "expect" */
    for (c = errmsg; *c; c++)
      if (*c == '\r' || *c == '\n')
	*c = ' ';
    strtrim(errmsg);

    ASPRINTF(&out, "%s %s: %s (errno=%d)",
	     _("Error connecting to PostgreSQL server at"), host, errmsg, errno);

    if (sql)
      PQfinish(sql);
    /* Try login via UNIX socket before failing, per Lee Brotherston <lee@nerds.org.uk> */
    sql = PQsetdbLogin(NULL, NULL, NULL, NULL, database, user, password);
    if (PQstatus(sql) == CONNECTION_BAD)
      Errx("%s", out);
    RELEASE(out);
  }
#else
  {
    SQL *new_sql = NULL;
    int used_index = -1;
    char *used_host = NULL;

    new_sql = mysql_connect_candidates(user, password, database, host, &used_index, &used_host);
    if (!new_sql) {
      Errx(_("Unable to connect to any configured MySQL host"));
    }

    sql = new_sql;
    mysql_remember_success(used_index);
    RELEASE(_sql_host);
    if (used_host)
      _sql_host = used_host;
    else if (host && *host)
      _sql_host = STRDUP(host);
    else
      _sql_host = STRDUP("localhost");
  }
#endif

#if USE_PGSQL
  if( host2 )
    RELEASE( host2 );
#endif
}
/*--- sql_open() --------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_REOPEN
	Attempt to close and reopen the database connection.
**************************************************************************************************/
void
sql_reopen(void) {
  SQL *new_sql = NULL;
  char *portp = NULL;
  unsigned int port = 0;

  if (_sql_host && (portp = strchr(_sql_host, ':'))) {
    port = atoi(portp + 1);
    *portp = '\0';
  }

#if USE_PGSQL
  new_sql = PQsetdbLogin(_sql_host, portp, NULL, NULL, _sql_database, _sql_user, _sql_password);
  if (PQstatus(new_sql) == CONNECTION_BAD) {
    if (new_sql)
      PQfinish(new_sql);
    /* Try login via UNIX socket before failing, per Lee Brotherston <lee@nerds.org.uk> */
    new_sql = PQsetdbLogin(NULL, NULL, NULL, NULL, _sql_database, _sql_user, _sql_password);
    if (PQstatus(new_sql) == CONNECTION_BAD) {
      if (new_sql)
	PQfinish(new_sql);
      return;
    }
  }
#else
  if (sql && !mysql_ping(sql)) return;
  {
    char *used_host = NULL;
    int used_index = -1;

    new_sql = mysql_connect_candidates(_sql_user, _sql_password, _sql_database,
				       _sql_host, &used_index, &used_host);
    if (!new_sql)
      return;

    mysql_remember_success(used_index);
    sql_close(sql);
    sql = new_sql;
    RELEASE(_sql_host);
    if (used_host)
      _sql_host = used_host;
    else if (_sql_host)
      _sql_host = STRDUP(_sql_host);
    else
      _sql_host = STRDUP("localhost");
  }
#endif

#if USE_PGSQL
  sql_close(sql);
  sql = new_sql;

  if (portp)
    *portp = ':';
#endif
}
/*--- sql_reopen() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_ISTABLE
	Returns 1 if the specified table exists in the current database, or 0 if it does not.
**************************************************************************************************/
int
sql_istable(SQL *sqlConn, const char *tablename) {
  char *xtablename;
#if !USE_PGSQL
  SQL_RES *res;
#endif
  int rv = 0;

  xtablename = sql_escstr(sqlConn, (char*)tablename);

#if USE_PGSQL
  if (sql_count(sqlConn, "SELECT COUNT(*) FROM pg_class"
		" WHERE (relkind='r' OR relkind='v') AND relname='%s'", xtablename) > 0)
    rv = 1;
#else
  if ((res = sql_queryf(sqlConn, "SHOW TABLES LIKE '%s'", xtablename))) {
    if (sql_num_rows(res) > 0)
      rv = 1;
    sql_free(res);
  }
#endif

  RELEASE(xtablename);
  return (rv);
}
/*--- sql_istable() -----------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_ISCOLUMN
	Returns 1 if the specified column exists in the current database, or 0 if it does not.
**************************************************************************************************/
int
sql_iscolumn(SQL *sqlConn, const char *tablename, const char *columnname) {
  char *xtablename, *xcolumnname;
#if !USE_PGSQL
  SQL_RES *res;
#endif
  int rv = 0;

  xtablename = sql_escstr(sqlConn, (char*)tablename);
  xcolumnname = sql_escstr(sqlConn, (char*)columnname);

#if USE_PGSQL
  if (sql_count(sqlConn,
		"SELECT COUNT(*)"
		" FROM pg_class,pg_attribute"
		" WHERE (relkind='r' OR relkind='v')"
		" AND relname='%s'"
		" AND attrelid=oid"
		" AND attname='%s'", xtablename, xcolumnname) > 0)
    rv = 1;
#else
  if ((res = sql_queryf(sqlConn, "SHOW COLUMNS FROM %s LIKE '%s'", xtablename, xcolumnname))) {
    if (sql_num_rows(res) > 0)
      rv = 1;
    sql_free(res);
  }
#endif

  RELEASE(xtablename);
  RELEASE(xcolumnname);
  return (rv);
}
/*--- sql_iscolumn() ----------------------------------------------------------------------------*/

int sql_get_column_width(SQL *sqlConn, const char *tablename, const char *columnname) {
  char *xtablename, *xcolumnname;
  int width = 0;

  xtablename = sql_escstr(sqlConn, (char*)tablename);
  xcolumnname = sql_escstr(sqlConn, (char*)columnname);

  {
    SQL_RES *res = sql_queryf(sqlConn,
			      "SELECT character_maximum_length FROM information_schema.columns "
			      "WHERE table_name='%s' AND column_name='%s'",
			      xtablename, xcolumnname);
    SQL_ROW row;

    row = sql_getrow(res, NULL);
    if (row) {
      width = atoi(row[0]);
    }
    sql_free(res);
  }

  RELEASE(xtablename);
  RELEASE(xcolumnname);
  return (width);
}
/**************************************************************************************************
	_SQL_CLOSE
**************************************************************************************************/
void
_sql_close(SQL *sqlConn) {
#if USE_PGSQL
  PQfinish(sqlConn);
#else
  mysql_close(sqlConn);
  RELEASE(sqlConn);
#endif
}
/*--- _sql_close() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_NRQUERY
	Issues an SQL query that does not return a result.  Returns 0 on success, -1 on error.
**************************************************************************************************/
int
sql_nrquery(SQL *sqlConn, const char *query, size_t querylen) {
#if USE_PGSQL
  ExecStatusType q_rv = PGRES_COMMAND_OK;
  PGresult *result = NULL;

  result = PQexec(sqlConn, query);
  q_rv = PQresultStatus(result);

  if (q_rv == PGRES_COMMAND_OK) {
    PQclear(result);
    return (0);
  } else {
    /* WarnSQL(sqlConn, _("%s: error during query"), PQresStatus(PQresultStatus(result))); */
    PQclear(result);
    return (-1);
  }
#else
  int retried = 0;
retry:
  if (mysql_real_query(sqlConn, query, querylen)) {
    unsigned int errcode = mysql_errno(sqlConn);
    if (!retried && mysql_should_retry(errcode) && sql_retry_connection(&sqlConn)) {
      retried = 1;
      goto retry;
    }
    if (mysql_error(sql)[0] != '\0')
      WarnSQL(sql, _("%s: error during query"), mysql_error(sql));
    return (-1);
  }
#endif

  return (0);
}
/*--- sql_nrquery() -----------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_QUERY
	Returns a query's result, or NULL on error.
**************************************************************************************************/
SQL_RES *
sql_query(SQL *sqlConn, const char *query, size_t querylen) {
  SQL_RES *res = NULL;
#if !USE_PGSQL
  int retried = 0;
#endif

#if USE_PGSQL
  ExecStatusType q_rv = PGRES_COMMAND_OK;
  PGresult *result = NULL;

  result = PQexec(sqlConn, query);
  q_rv = PQresultStatus(result);

  if (q_rv == PGRES_TUPLES_OK) {
    res = ALLOCATE(sizeof(SQL_RES), SQL_RES);
    res->result = result;
    res->tuples = PQntuples(result);
    res->fields = PQnfields(result);
    res->current_tuple = 0;
    res->current_row = ALLOCATE(res->fields * sizeof(unsigned char *), unsigned char[]);
    res->current_length = ALLOCATE(res->fields * sizeof(int *), int[]);
  } else if (q_rv == PGRES_COMMAND_OK) {
    PQclear(result);
    return (NULL);
  } else {
    /* WarnSQL(sqlConn, _("%s: error during query"), PQresStatus(PQresultStatus(result))); */
    PQclear(result);
    return (NULL);
  }
#else
retry:
  if (mysql_real_query(sqlConn, query, querylen)
      || !(res = mysql_store_result(sqlConn))) {
    unsigned int errcode = mysql_errno(sqlConn);
    if (!retried && mysql_should_retry(errcode) && sql_retry_connection(&sqlConn)) {
      retried = 1;
      goto retry;
    }
    if (mysql_error(sql)[0] != '\0')
      WarnSQL(sql, _("%s: error during query"), mysql_error(sql));
    return (NULL);
  }
#endif

  return (res);
}
/*--- sql_query() -------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_QUERYF
	Like sql_query, but accepts varargs format.
**************************************************************************************************/
SQL_RES *
sql_queryf(SQL *sqlConn, const char *fmt, ...) {
  va_list	ap;
  char		*buf = NULL;
  size_t	buflen;
  SQL_RES	*res;

  va_start(ap, fmt);
  buflen = VASPRINTF(&buf, fmt, ap);
  va_end(ap);

  res = sql_query(sqlConn, buf, buflen);
  RELEASE(buf);

  return (res);
}
/*--- sql_queryf() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_COUNT
	Provided a statement like "SELECT COUNT(*)..." returns the count returned, or -1 if an error
	occurred.
**************************************************************************************************/
long
sql_count(SQL *sqlConn, const char *fmt, ...) {
  va_list	ap;
  char		*buf = NULL;
  size_t	buflen;
  SQL_RES	*res = NULL;
  long		rv = 0;

  va_start(ap, fmt);
  buflen = VASPRINTF(&buf, fmt, ap);
  va_end(ap);

  res = sql_query(sqlConn, buf, buflen);
  RELEASE(buf);

  if (!res)
    return (-1);
  if (sql_num_rows(res)) {
#if USE_PGSQL
    rv = atol(PQgetvalue(res->result, 0, 0));
#else
    MYSQL_ROW row;

    if ((row = mysql_fetch_row(res)))
      rv = atol(row[0]);
#endif
  }
  sql_free(res);
  return (rv);
}
/*--- sql_count() -------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_NUM_ROWS
	Returns the number of rows in a result set.
**************************************************************************************************/
long
sql_num_rows(SQL_RES *res) {
#if USE_PGSQL
  return res->tuples;
#else
  return mysql_num_rows(res);
#endif
}
/*--- sql_num_rows() ----------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_GETROW
	Returns the next row from the result, or NULL if no more rows exist.
**************************************************************************************************/
SQL_ROW
sql_getrow(SQL_RES *res, unsigned long **lengths) {
#if USE_PGSQL
  register int n;

  if (res->current_tuple >= res->tuples)
    return (NULL);
  for (n = 0; n < res->fields; n++) {
    res->current_row[n] = PQgetvalue(res->result, res->current_tuple, n);
    res->current_length[n] = PQgetlength(res->result, res->current_tuple, n);
  }
  if (lengths) *lengths = res->current_length;
  res->current_tuple++;
  return (res->current_row);
#else
  SQL_ROW row = mysql_fetch_row(res);
  if (lengths) *lengths = mysql_fetch_lengths(res);
  return row;
#endif
}
/*--- sql_getrow() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	SQL_ESCSTR
	Escapes a string to make it suitable for an SQL query.
**************************************************************************************************/
char *
sql_escstr2(SQL *sqlConn, char *src, size_t srclen) {
  char *dest = ALLOCATE(srclen*2+1, char[]);
  size_t reslen;
#if USE_PGSQL
  int errcode = 0;
  reslen =   PQescapeStringConn(sqlConn, dest, src, srclen, &errcode);
#else
  reslen = mysql_real_escape_string(sqlConn, dest, src, srclen);
#endif
  dest = REALLOCATE(dest, reslen+1, char[]);
  return dest;
}

char *
sql_escstr(SQL *sqlConn, char *src) {
  return sql_escstr2(sqlConn, src, strlen(src));
}
/*--- sql_escstr() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	_SQL_FREE
	Free an SQL result.
**************************************************************************************************/
void
_sql_free(SQL_RES *res) {
#if USE_PGSQL
  RELEASE(res->current_length);
  RELEASE(res->current_row);
  PQclear(res->result);
  RELEASE(res);
#else
  mysql_free_result(res);
#endif
}
/*--- _sql_free() -------------------------------------------------------------------------------*/
int
sql_build_query(char **query, const char *fmt, ...) {
  va_list ap;
  int querylen;

  va_start(ap, fmt);
  querylen = VASPRINTF(query, fmt, ap);
  va_end(ap);

  return querylen;
}

/* vi:set ts=3: */
