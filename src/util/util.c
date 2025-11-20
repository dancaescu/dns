/**************************************************************************************************
	$Id: util.c,v 1.25 2005/04/20 16:49:12 bboy Exp $

	util.c: Routines shared by the utility programs.

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

#include "util.h"


/**************************************************************************************************
	DB_CONNECT
	Connect to the database.
**************************************************************************************************/
void
db_connect(void)
{
  const char *user = conf_get(&Conf, "db-user", NULL);
  const char *host_values[SQL_MAX_DB_HOSTS];
  const char *hosts[SQL_MAX_DB_HOSTS];
  size_t host_count = 0;
  const char *primary_host = NULL;
  const char *database = conf_get(&Conf, "database", NULL);
  const char *password = conf_get(&Conf, "db-password", NULL);
  const char *policy = conf_get(&Conf, "db-host-policy", NULL);
  size_t i;

  /* If db- vars aren't present, try mysql- for backwards compatibility */
  if (!user) user = conf_get(&Conf, "mysql-user", NULL);
  if (!password) password = conf_get(&Conf, "mysql-password", NULL);
  if (!password) password = conf_get(&Conf, "mysql-pass", NULL);

  host_values[0] = conf_get(&Conf, "db-host", NULL);
  host_values[1] = conf_get(&Conf, "db-host2", NULL);
  host_values[2] = conf_get(&Conf, "db-host3", NULL);
  host_values[3] = conf_get(&Conf, "db-host4", NULL);

  for (i = 0; i < SQL_MAX_DB_HOSTS; i++) {
    if (host_values[i] && *host_values[i]) {
      hosts[host_count++] = host_values[i];
      if (!primary_host)
	primary_host = host_values[i];
    }
  }

  /* Backwards compatibility for utilities that still use mysql-* options */
  if (!primary_host) {
    const char *legacy = conf_get(&Conf, "mysql-host", NULL);
    if (legacy && *legacy) {
      hosts[host_count++] = legacy;
      primary_host = legacy;
    }
  }

  sql_configure_hosts(hosts, host_count, policy);

  if (!primary_host)
    primary_host = conf_get(&Conf, "db-host", NULL);

  sql_open(user, password, primary_host, database);
  {
    const char *active = sql_active_host();
    Verbose(_("connected to %s, database \"%s\""),
	    (active && *active) ? active : _("(default)"),
	    database);
  }
}
/*--- db_connect() ------------------------------------------------------------------------------*/


/**************************************************************************************************
	METER
	Outputs a very simple progress meter - only used if stderr is a terminal.
	If "total" is zero, the meter is erased.
**************************************************************************************************/
void
meter(unsigned long current, unsigned long total) {
  static char *m = NULL;
  int num;
  time_t now;
  static time_t last_update = 0;

  if (!isatty(STDERR_FILENO))
    return;

  if (!m) m = ALLOCATE(80, char[]);

  if (!total || current > total) {						/* Erase meter */
    memset(m, ' ', 73);
    m[72] = '\r';
    fwrite(m, 73, 1, stderr);
    fflush(stderr);
    last_update = 0;
    return;
  }

  if (current % 5)
    return;

  time(&now);
  if (now == last_update)
    return;
  last_update = now;

  /* Create meter */
  memset(m, '.', 63);
  m[0] = m[60] = '|';
  m[5] = m[10] = m[15] = m[20] = m[25] = m[30] = m[35] = m[40] = m[45] = m[50] = m[55] = ':';
  m[61] = '\r';
  m[62] = '\0';

  num = ((double)((double)current / (double)total) * 58.0) + 1;
  memset(m + 1, '#', num < 0 || num > 58 ? 58 : num);
  fprintf(stderr, "  %6.2f%% %s\r", PCT(total,current), m);
  fflush(stderr);
}
/*--- meter() -----------------------------------------------------------------------------------*/

/* vi:set ts=3: */
/* NEED_PO */
