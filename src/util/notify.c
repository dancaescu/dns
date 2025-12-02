/**********************************************************************************************
	mydns-notify: Send DNS NOTIFY messages for a zone

	Copyright (C) 2025

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
**********************************************************************************************/

#include "util.h"
#include "../lib/tsig.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>

#define DOMAINPORT 53

/* Forward declarations */
static char *dns_make_notify_packet(uint16_t id, const char *zone, size_t *packet_len);
static int send_notify_to_slave(const char *slave_ip, const char *zone, tsig_key_t *tsig_key);
static int parse_and_notify(const char *zone_name, tsig_key_t *tsig_key);

/**********************************************************************************************
	USAGE
	Display program usage information.
**********************************************************************************************/
static void
usage(int status) {
  if (status != EXIT_SUCCESS) {
    fprintf(stderr, _("Try `%s --help' for more information."), progname);
    fputs("\n", stderr);
  } else {
    printf(_("Usage: %s [OPTIONS] ZONE"), progname);
    puts("");
    puts(_("Send DNS NOTIFY messages to slaves for the specified zone."));
    puts("");
    puts(_("Options:"));
    puts(_("  -f, --conf=FILE         read config from FILE instead of the default"));
    puts(_("  -D, --database=DB       database name to use"));
    puts(_("  -h, --host=HOST         connect to SQL server at HOST"));
    puts(_("  -p, --password=PASS     password for SQL server (or prompt from tty)"));
    puts(_("  -u, --user=USER         username for SQL server if not current user"));
    puts("");
#if DEBUG_ENABLED
    puts(_("  -d, --debug             enable debug output"));
#endif
    puts(_("  -v, --verbose           be more verbose while running"));
    puts(_("      --help              display this help and exit"));
    puts(_("      --version           output version information and exit"));
    puts("");
    puts(_("Examples:"));
    puts(_("  mydns-notify example.com."));
    puts(_("  mydns-notify --conf=/etc/mydns.conf test.zone."));
    puts("");
    printf(_("Report bugs to <%s>.\n"), PACKAGE_BUGREPORT);
  }
  exit(status);
}
/*--- usage() -------------------------------------------------------------------------------*/


/**********************************************************************************************
	CMDLINE
	Process command line options.
**********************************************************************************************/
static void
cmdline(int argc, char **argv) {
  char	*optstr;
  int	optc, optindex;
  struct option const longopts[] = {
    {"conf",			required_argument,	NULL,	'f'},
    {"database",		required_argument,	NULL,	'D'},
    {"host",			required_argument,	NULL,	'h'},
    {"password",		optional_argument,	NULL,	'p'},
    {"user",			required_argument,	NULL,	'u'},
    {"debug",			no_argument,		NULL,	'd'},
    {"verbose",			no_argument,		NULL,	'v'},
    {"help",			no_argument,		NULL,	0},
    {"version",			no_argument,		NULL,	0},
    {NULL,			0,			NULL,	0}
  };

  err_file = stdout;
  error_init(argv[0], LOG_USER);				/* Init output routines */
  optstr = getoptstr(longopts);
  while ((optc = getopt_long(argc, argv, optstr, longopts, &optindex)) != -1) {
    switch (optc) {
    case 0:
      {
	const char *opt = longopts[optindex].name;

	if (!strcmp(opt, "version")) {				/* --version */
	  printf("%s ("PACKAGE_NAME") "PACKAGE_VERSION" ("SQL_VERSION_STR")\n", progname);
	  puts("\n" PACKAGE_COPYRIGHT);
	  puts(_("This is free software; see the source for copying conditions.  There is NO"));
	  puts(_("warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE."));
	  exit(EXIT_SUCCESS);
	} else if (!strcmp(opt, "help"))			/* --help */
	  usage(EXIT_SUCCESS);
      }
      break;

    case 'f':							/* -f, --conf=FILE */
      opt_conf = optarg;
      break;

    case 'D':							/* -D, --database=DB */
      conf_set(&Conf, "database", optarg, 0);
      break;

    case 'h':							/* -h, --host=HOST */
      conf_set(&Conf, "db-host", optarg, 0);
      break;

    case 'p':							/* -p, --password=PASS */
      if (optarg) {
	conf_set(&Conf, "db-password", optarg, 0);
	memset(optarg, 'X', strlen(optarg));
      } else
	conf_set(&Conf, "db-password", passinput(_("Enter password")), 0);
      break;

    case 'u':							/* -u, --user=USER */
      conf_set(&Conf, "db-user", optarg, 0);
      break;

#if DEBUG_ENABLED
    case 'd':							/* -d, --debug */
      err_verbose = err_debug = 1;
      break;
#endif

    case 'v':							/* -v, --verbose */
      err_verbose = 1;
      break;

    default:
      usage(EXIT_FAILURE);
    }
  }

  if (optind >= argc) {
    fprintf(stderr, _("%s: missing zone name\n"), progname);
    usage(EXIT_FAILURE);
  }
}
/*--- cmdline() -----------------------------------------------------------------------------*/


/**********************************************************************************************
	DNS_MAKE_NOTIFY_PACKET
	Build a DNS NOTIFY packet for the specified zone.
	Returns allocated packet data and sets packet_len.
**********************************************************************************************/
static char *
dns_make_notify_packet(uint16_t id, const char *zone, size_t *packet_len) {
  size_t zonelen = strlen(zone);
  size_t pktlen = 12 + zonelen + 2 + 4;  /* Header + QNAME + QTYPE + QCLASS */
  char *packet = ALLOCATE(pktlen, char[]);
  char *p = packet;
  const char *label_start = zone;
  const char *dot;

  /* DNS Header */
  *p++ = (id >> 8) & 0xFF;
  *p++ = id & 0xFF;
  *p++ = 0x20;  /* Flags: Opcode=4 (NOTIFY), AA=1 */
  *p++ = 0x00;
  *p++ = 0x00;  /* QDCOUNT = 1 (high) */
  *p++ = 0x01;  /* QDCOUNT = 1 (low) */
  *p++ = 0x00;  /* ANCOUNT = 0 */
  *p++ = 0x00;
  *p++ = 0x00;  /* NSCOUNT = 0 */
  *p++ = 0x00;
  *p++ = 0x00;  /* ARCOUNT = 0 */
  *p++ = 0x00;

  /* Question section - QNAME */
  while ((dot = strchr(label_start, '.')) != NULL) {
    size_t label_len = dot - label_start;
    if (label_len > 0) {
      *p++ = (char)label_len;
      memcpy(p, label_start, label_len);
      p += label_len;
    }
    label_start = dot + 1;
  }
  *p++ = 0x00;  /* End of QNAME */

  /* QTYPE = SOA (6) */
  *p++ = 0x00;
  *p++ = 0x06;

  /* QCLASS = IN (1) */
  *p++ = 0x00;
  *p++ = 0x01;

  *packet_len = p - packet;
  return packet;
}
/*--- dns_make_notify_packet() --------------------------------------------------------------*/


/**********************************************************************************************
	SEND_NOTIFY_TO_SLAVE
	Send a DNS NOTIFY packet to a single slave server.
	Returns 0 on success, -1 on error.
**********************************************************************************************/
static int
send_notify_to_slave(const char *slave_ip, const char *zone, tsig_key_t *tsig_key) {
  int sockfd = -1;
  struct sockaddr_in addr4;
#if HAVE_IPV6
  struct sockaddr_in6 addr6;
#endif
  struct sockaddr *addr = NULL;
  socklen_t addrlen = 0;
  char *packet = NULL;
  size_t packet_len = 0;
  char *send_packet = NULL;
  size_t send_len = 0;
  int rv = -1;
  uint16_t id = (uint16_t)random();

  /* Build NOTIFY packet */
  packet = dns_make_notify_packet(id, zone, &packet_len);
  if (!packet) {
    Warnx(_("Failed to create NOTIFY packet for zone %s"), zone);
    return -1;
  }

  /* Try IPv4 first */
  memset(&addr4, 0, sizeof(addr4));
  if (inet_pton(AF_INET, slave_ip, &addr4.sin_addr) == 1) {
    addr4.sin_family = AF_INET;
    addr4.sin_port = htons(DOMAINPORT);
    addr = (struct sockaddr *)&addr4;
    addrlen = sizeof(addr4);
    sockfd = socket(AF_INET, SOCK_DGRAM, 0);
  }
#if HAVE_IPV6
  /* Try IPv6 if IPv4 failed */
  else {
    memset(&addr6, 0, sizeof(addr6));
    if (inet_pton(AF_INET6, slave_ip, &addr6.sin6_addr) == 1) {
      addr6.sin6_family = AF_INET6;
      addr6.sin6_port = htons(DOMAINPORT);
      addr = (struct sockaddr *)&addr6;
      addrlen = sizeof(addr6);
      sockfd = socket(AF_INET6, SOCK_DGRAM, 0);
    }
  }
#endif

  if (sockfd < 0) {
    Warnx(_("Invalid IP address or socket creation failed: %s"), slave_ip);
    RELEASE(packet);
    return -1;
  }

  /* Sign with TSIG if key provided */
  if (tsig_key) {
    size_t max_tsig_len = 200;
    char *signed_packet = ALLOCATE(packet_len + max_tsig_len, char[]);
    if (signed_packet) {
      memcpy(signed_packet, packet, packet_len);
      size_t new_len = 0;

      if (tsig_sign((unsigned char*)signed_packet, packet_len, packet_len + max_tsig_len,
                    tsig_key, NULL, 0, &new_len) == 0) {
        send_packet = signed_packet;
        send_len = new_len;
        Verbose(_("NOTIFY to %s signed with TSIG key '%s'"), slave_ip, tsig_key->name);
      } else {
        Warnx(_("TSIG signing failed for NOTIFY to %s"), slave_ip);
        RELEASE(signed_packet);
        send_packet = packet;
        send_len = packet_len;
      }
    } else {
      send_packet = packet;
      send_len = packet_len;
    }
  } else {
    send_packet = packet;
    send_len = packet_len;
  }

  /* Send NOTIFY */
  rv = sendto(sockfd, send_packet, send_len, 0, addr, addrlen);
  if (rv < 0) {
    Warn(_("Failed to send NOTIFY to %s: %s"), slave_ip, strerror(errno));
    rv = -1;
  } else {
    Verbose(_("Sent NOTIFY for zone %s to %s"), zone, slave_ip);
    rv = 0;
  }

  /* Cleanup */
  close(sockfd);
  if (send_packet != packet) {
    RELEASE(send_packet);
  }
  RELEASE(packet);

  return rv;
}
/*--- send_notify_to_slave() ----------------------------------------------------------------*/


/**********************************************************************************************
	PARSE_AND_NOTIFY
	Load zone SOA, parse also_notify field, and send NOTIFY to all slaves.
	Returns number of successful NOTIFYs sent.
**********************************************************************************************/
static int
parse_and_notify(const char *zone_name, tsig_key_t *tsig_key) {
  MYDNS_SOA *soa = NULL;
  SQL_RES *res = NULL;
  SQL_ROW row = NULL;
  char *query = NULL;
  size_t querylen = 0;
  int notify_count = 0;
  int success_count = 0;

  /* Load SOA record */
  if (mydns_soa_load(sql, &soa, zone_name) != 0 || !soa) {
    Warnx(_("Zone not found: %s"), zone_name);
    return 0;
  }

  Verbose(_("Loaded SOA for zone %s (id=%u)"), soa->origin, soa->id);

  /* Check if also_notify column exists */
  if (!sql_iscolumn(sql, mydns_soa_table_name, "also_notify")) {
    Warnx(_("Database table '%s' does not have 'also_notify' column"), mydns_soa_table_name);
    Warnx(_("No slaves configured for zone %s"), zone_name);
    mydns_soa_free(soa);
    return 0;
  }

  /* Retrieve also_notify field */
  querylen = sql_build_query(&query, "SELECT also_notify FROM %s WHERE id=%u",
                              mydns_soa_table_name, soa->id);
  res = sql_query(sql, query, querylen);
  RELEASE(query);

  if (!res) {
    WarnSQL(sql, _("Failed to query also_notify for zone %s"), zone_name);
    mydns_soa_free(soa);
    return 0;
  }

  if ((row = sql_getrow(res, NULL)) && row[0] && strlen(row[0]) > 0) {
    char *also_notify = STRDUP(row[0]);
    char *slave_ip = also_notify;
    char *comma;

    Verbose(_("also_notify field: %s"), also_notify);

    /* Parse comma-separated list of slave IPs */
    while (slave_ip && *slave_ip) {
      /* Trim leading whitespace */
      while (*slave_ip == ' ' || *slave_ip == '\t') slave_ip++;
      if (!*slave_ip) break;

      /* Find comma or end of string */
      comma = strchr(slave_ip, ',');
      if (comma) {
        *comma = '\0';
      }

      /* Trim trailing whitespace */
      char *end = slave_ip + strlen(slave_ip) - 1;
      while (end > slave_ip && (*end == ' ' || *end == '\t')) {
        *end = '\0';
        end--;
      }

      /* Send NOTIFY to this slave */
      if (*slave_ip) {
        notify_count++;
        if (send_notify_to_slave(slave_ip, soa->origin, tsig_key) == 0) {
          success_count++;
        }
      }

      /* Move to next slave */
      if (comma) {
        slave_ip = comma + 1;
      } else {
        break;
      }
    }

    RELEASE(also_notify);
  } else {
    Warnx(_("No slaves configured in also_notify field for zone %s"), zone_name);
  }

  sql_free(res);
  mydns_soa_free(soa);

  if (notify_count > 0) {
    Verbose(_("Sent NOTIFY to %d/%d slave(s) for zone %s"),
            success_count, notify_count, zone_name);
  }

  return success_count;
}
/*--- parse_and_notify() --------------------------------------------------------------------*/


/**************************************************************************************************
	MAIN
**************************************************************************************************/
int
main(int argc, char **argv) {
  const char *zone_name;
  tsig_key_t *tsig_key = NULL;
  SQL_RES *tsig_res = NULL;
  SQL_ROW tsig_row = NULL;
  int result = 0;

  setlocale(LC_ALL, "");					/* Internationalization */
  bindtextdomain(PACKAGE, LOCALEDIR);
  textdomain(PACKAGE);

  /* Seed random for DNS query IDs */
  srandom(time(NULL) ^ getpid());

  cmdline(argc, argv);
  load_config();
  db_connect();

  zone_name = argv[optind];

  /* Ensure zone name ends with dot */
  char *normalized_zone = NULL;
  if (zone_name[strlen(zone_name) - 1] != '.') {
    normalized_zone = ALLOCATE(strlen(zone_name) + 2, char[]);
    strcpy(normalized_zone, zone_name);
    strcat(normalized_zone, ".");
    zone_name = normalized_zone;
  }

  Verbose(_("Processing NOTIFY for zone: %s"), zone_name);

  /* Try to load TSIG key if available */
  if (sql_iscolumn(sql, "tsig_keys", "name")) {
    char tsig_query[256];
    snprintf(tsig_query, sizeof(tsig_query),
             "SELECT name, algorithm, secret FROM tsig_keys WHERE enabled=1 AND allow_notify=1 LIMIT 1");

    if ((tsig_res = sql_query(sql, tsig_query, strlen(tsig_query)))) {
      if ((tsig_row = sql_getrow(tsig_res, NULL))) {
        tsig_key = tsig_key_create(tsig_row[0], tsig_row[1], tsig_row[2]);
        if (tsig_key) {
          Verbose(_("Using TSIG key '%s' for NOTIFY messages"), tsig_row[0]);
        }
      }
      sql_free(tsig_res);
    }
  }

  /* Send NOTIFY messages */
  result = parse_and_notify(zone_name, tsig_key);

  /* Cleanup */
  if (tsig_key) {
    tsig_key_free(tsig_key);
  }

  if (normalized_zone) {
    RELEASE(normalized_zone);
  }

  if (result > 0) {
    printf(_("Successfully sent NOTIFY to %d slave(s)\n"), result);
    return EXIT_SUCCESS;
  } else {
    fprintf(stderr, _("Failed to send NOTIFY messages\n"));
    return EXIT_FAILURE;
  }
}
/*--- main() ------------------------------------------------------------------------------------*/

/* vi:set ts=2: */
