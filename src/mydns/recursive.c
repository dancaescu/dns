/**************************************************************************************************
	$Id: recursive.c,v 1.8 2005/03/22 17:44:57 bboy Exp $

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

#include <assert.h>

#include "named.h"

/* Make this nonzero to enable debugging for this source file */
#define	DEBUG_RECURSIVE	1

static TASK *udp_recursive_master = NULL;
static TASK *tcp_recursive_master = NULL;

static int recursive_udp_fd = -1;
static int recursive_tcp_fd = -1;
static uint32_t tcp_recursion_running = 0;
static uint32_t udp_recursion_running = 0;

typedef struct _recursive_fwd_write_t {
  char		*query;
  uint16_t	querylength;
  uint16_t	querywritten;
  uint16_t	querylenwritten;
  int		retries;
} recursive_fwd_write_t;

/**************************************************************************************************
	GET_NEXT_HEALTHY_RECURSIVE_SERVER
	Select next healthy server in round-robin fashion. If all servers are unhealthy,
	retry servers that haven't been tried recently.
**************************************************************************************************/
static int
get_next_healthy_recursive_server(void) {
  int i, attempts = 0;
  time_t now = time(NULL);
  int start_index = recursive_server_current;

  if (!recursive_servers || recursive_server_count == 0) {
    return -1;
  }

  /* Try to find a healthy server, round-robin style */
  while (attempts < recursive_server_count) {
    int idx = (start_index + attempts) % recursive_server_count;

    if (recursive_servers[idx].is_healthy) {
      recursive_server_current = idx;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("selected healthy server [%d]: %s"),
             idx, recursive_servers[idx].address);
#endif
      return idx;
    }

    /* If server is unhealthy but enough time has passed, retry it */
    if ((now - recursive_servers[idx].last_failure) >= RECURSIVE_RETRY_TIMEOUT) {
      recursive_servers[idx].is_healthy = 1;
      recursive_servers[idx].consecutive_failures = 0;
      recursive_server_current = idx;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("retrying previously failed server [%d]: %s"),
             idx, recursive_servers[idx].address);
#endif
      return idx;
    }

    attempts++;
  }

  /* All servers are unhealthy and retry timeout not reached - use current anyway */
  Warnx(_("all recursive servers unhealthy, using server [%d]: %s anyway"),
        recursive_server_current, recursive_servers[recursive_server_current].address);
  return recursive_server_current;
}

/**************************************************************************************************
	MARK_RECURSIVE_SERVER_FAILED
	Mark current recursive server as having failed. Update health status.
**************************************************************************************************/
static void
mark_recursive_server_failed(void) {
  if (!recursive_servers || recursive_server_count == 0) return;

  int idx = recursive_server_current;
  recursive_servers[idx].consecutive_failures++;
  recursive_servers[idx].last_failure = time(NULL);

  if (recursive_servers[idx].consecutive_failures >= RECURSIVE_MAX_FAILURES) {
    recursive_servers[idx].is_healthy = 0;
    Warnx(_("marking recursive server [%d]: %s as UNHEALTHY after %d consecutive failures"),
          idx, recursive_servers[idx].address, recursive_servers[idx].consecutive_failures);
  }

  /* Move to next server */
  recursive_server_current = (recursive_server_current + 1) % recursive_server_count;
}

/**************************************************************************************************
	MARK_RECURSIVE_SERVER_SUCCESS
	Mark current recursive server as having succeeded. Reset failure counters.
**************************************************************************************************/
static void
mark_recursive_server_success(void) {
  if (!recursive_servers || recursive_server_count == 0) return;

  int idx = recursive_server_current;
  recursive_servers[idx].consecutive_failures = 0;
  recursive_servers[idx].last_success = time(NULL);

  if (!recursive_servers[idx].is_healthy) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("marking recursive server [%d]: %s as HEALTHY after successful query"),
           idx, recursive_servers[idx].address);
#endif
  }
  recursive_servers[idx].is_healthy = 1;
}

typedef struct _recursive_fwd_read_t {
  char		*reply;
  uint16_t	replylength;
  uint16_t	replyread;
  uint16_t	replylenread;
} recursive_fwd_read_t;

static int
get_serveraddr(struct sockaddr **rsa) {
  socklen_t		rsalen = 0;
  int			server_idx;

  /* Use round-robin with health checking if multiple servers configured */
  if (recursive_servers && recursive_server_count > 0) {
    /* Select next healthy server */
    server_idx = get_next_healthy_recursive_server();
    if (server_idx < 0) {
      Warnx(_("get_serveraddr: no recursive servers available"));
      return 0;
    }

    /* Update global state for compatibility */
    recursive_family = recursive_servers[server_idx].family;
    recursive_fwd_server = recursive_servers[server_idx].address;

    if (recursive_family == AF_INET) {
      memcpy(&recursive_sa, &recursive_servers[server_idx].addr.sa4, sizeof(struct sockaddr_in));
      *rsa = (struct sockaddr*)&recursive_sa;
      rsalen = sizeof(struct sockaddr_in);
#if HAVE_IPV6
    } else if (recursive_family == AF_INET6) {
      memcpy(&recursive_sa6, &recursive_servers[server_idx].addr.sa6, sizeof(struct sockaddr_in6));
      *rsa = (struct sockaddr*)&recursive_sa6;
      rsalen = sizeof(struct sockaddr_in6);
#endif
    }
  } else {
    /* Fallback to old single-server mode */
    if (recursive_family == AF_INET) {
      *rsa = (struct sockaddr*)&recursive_sa;
      rsalen = sizeof(struct sockaddr_in);
#if HAVE_IPV6
    } else if (recursive_family == AF_INET6) {
      *rsa = (struct sockaddr*)&recursive_sa6;
      rsalen = sizeof(struct sockaddr_in6);
#endif
    }
  }
  return rsalen;
}

typedef time_t (*RecursionAlgorithm)(TASK *, int);

static time_t
_recursive_linear(TASK *t, int retries) {
  return (recursion_timeout);
}

static time_t
_recursive_exponential(TASK *t, int retries) {
  time_t timeout = recursion_timeout;
  int i = 0;

  for (i = 1; i < retries; i++)
    timeout += timeout;

  return (timeout);
}

static time_t
_recursive_progressive(TASK *t, int retries) {
  return (recursion_timeout * (retries+1));
}

static time_t
_recursive_timeout(TASK *t, recursive_fwd_write_t *querypacket) {
  static RecursionAlgorithm _recursive_algorithm = NULL;
  time_t timeout = 0;
  int retries = 1;

  if (querypacket) {
    retries = querypacket->retries;
  }

  if (!_recursive_algorithm) {
    if (!strcasecmp(recursion_algorithm, "linear")) _recursive_algorithm = _recursive_linear;
    else if (!strcasecmp(recursion_algorithm, "exponential")) _recursive_algorithm = _recursive_exponential;
    else if (!strcasecmp(recursion_algorithm, "progressive")) _recursive_algorithm = _recursive_progressive;
    else _recursive_algorithm = _recursive_linear;
  }

  timeout = _recursive_algorithm(t, retries);

  return timeout;
}

/**************************************************************************************************
	RECURSIVE_FWD
	Forward a request to a recursive server.
**************************************************************************************************/
static taskexec_t
__recursive_start_comms(TASK *t, int *fd, int protocol) {

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1,
	 _("%s: recursive_start_comms called for protocol %s"), desctask(t), (protocol == SOCK_STREAM) ? "TCP" : "UDP");
#endif
  if ((*fd = socket(recursive_family, protocol, 0)) < 0) {
    Warn("%s: %s", recursive_fwd_server, _("error creating socket for recursive forwarding"));
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }
#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1,
	 _("%s: recursive_start_comms returns fd = %d"), desctask(t), *fd);
#endif
  return TASK_COMPLETED;
}

static void
__recursive_fwd_write_free(TASK *t, void *data) {
  recursive_fwd_write_t	*querypacket = (recursive_fwd_write_t*)data;

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1,
	 _("%s: recursive_fwd_write_free"), desctask(t));
#endif
  if (querypacket) {
    if (querypacket->query) RELEASE(querypacket->query);
    memset(querypacket, 0, sizeof(recursive_fwd_write_t));
  }
}

static void
__recursive_fwd_read_free(TASK *t, void * data) {

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1,
	 _("%s: recursive_fwd_read_free"), desctask(t));
#endif
  if (t->protocol == SOCK_STREAM
      && (   t->status == NEED_RECURSIVE_FWD_CONNECT
	  || t->status == NEED_RECURSIVE_FWD_CONNECTING)
      ) {
    QUEUE **connectQ = (QUEUE**)data;
    RELEASE(*connectQ);
  } else if (t->protocol == SOCK_DGRAM
	     && t->status == NEED_RECURSIVE_FWD_CONNECT) {
    QUEUE **connectQ = (QUEUE**)data;
    RELEASE(*connectQ);
  } else {
    recursive_fwd_read_t *replypacket = (recursive_fwd_read_t*)data;
    if (replypacket) {
      if(replypacket->reply) RELEASE(replypacket->reply);
      memset(replypacket, 0, sizeof(recursive_fwd_read_t));
    }
  }
  if (t->protocol == SOCK_STREAM && tcp_recursive_master == t) {
    tcp_recursive_master = NULL;
  } else if (t->protocol == SOCK_DGRAM && udp_recursive_master == t) {
    udp_recursive_master = NULL;
  } else {
    Warnx("%s: recursive_fwd_read_free called on a task that is not a recursive master", desctask(t));
  }
}

static taskexec_t
__recursive_fwd_write_timeout(TASK *t, void *data) {
  recursive_fwd_write_t *querypacket = (recursive_fwd_write_t*)data;

  if (t->status == NEED_RECURSIVE_FWD_WRITE) {
    return TASK_CONTINUE;
  }

  /* If the task is not waiting for read i.e. in retry state then throw an error */
  if ((t->status != NEED_RECURSIVE_FWD_RETRY)
      /* If the task has already retried the maximum times then throw an error */
      || (querypacket->retries++ > recursion_retries)) {
    /* Mark server as failed due to timeout */
    mark_recursive_server_failed();
    dnserror(t, DNS_RCODE_SERVFAIL, ERR_TIMEOUT);
    t->status = NEED_WRITE;
    if (t->protocol == SOCK_STREAM)
      task_change_type(t, IO_TASK);
    else
      task_change_type(t, NORMAL_TASK);
    return TASK_CONTINUE;
  }

  if (t->protocol == SOCK_STREAM) {
    sockclose(recursive_tcp_fd);
    if (__recursive_start_comms(t, &recursive_tcp_fd, SOCK_STREAM) == TASK_COMPLETED) {
      tcp_recursive_master->status = NEED_RECURSIVE_FWD_CONNECT;
      return TASK_CONTINUE;
    }
    return TASK_FAILED;
  } else {
    querypacket->querywritten = 0;
    t->status = NEED_RECURSIVE_FWD_WRITE;
    return TASK_CONTINUE;
  }
}

static taskexec_t
__recursive_fwd_read_timeout(TASK *t, void *data) {

  if (t->protocol == SOCK_STREAM) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: read_timeout with tcp_recursion_running = %d"),
	   desctask(t), tcp_recursion_running);
#endif
    if (!((t->status == NEED_RECURSIVE_FWD_CONNECT) || (t->status == NEED_RECURSIVE_FWD_CONNECTING))
	&& (tcp_recursion_running)) {
      /* How often do we allow this to continue */
      t->timeout = current_time + 120;
      return TASK_CONTINUE;
    }
    if (recursive_tcp_fd >= 0) sockclose(recursive_tcp_fd);
    recursive_tcp_fd  = -1;
    return TASK_TIMED_OUT;
  }
  t->timeout = current_time + 120;
  return TASK_CONTINUE;
}

static taskexec_t
__recursive_fwd_reconnect_tcp(TASK *t) {
  sockclose(recursive_tcp_fd);
  if (__recursive_start_comms(t, &recursive_tcp_fd, SOCK_STREAM) == TASK_COMPLETED) {
    if (t->extension) {
      t->freeextension(t, t->extension);
      RELEASE(t->extension);
      t->extension = NULL;
    }
    t->status = NEED_RECURSIVE_FWD_CONNECT;
    return TASK_CONTINUE;
  }
  return TASK_FAILED;
}

static taskexec_t
__recursive_fwd_reconnect_read(TASK *t) {
  sockclose(recursive_tcp_fd);
  if (__recursive_start_comms(t, &recursive_tcp_fd, SOCK_STREAM) == TASK_COMPLETED) {
    return TASK_CONTINUE;
  }
  return TASK_FAILED;
}

static taskexec_t
__recursive_fwd_setup_query(TASK *t, recursive_fwd_write_t **querypacket) {
  recursive_fwd_write_t	*qp = NULL;

  if (!querypacket)
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  *querypacket = qp = (recursive_fwd_write_t*)t->extension;

  if (!qp) {
    *querypacket = qp = (recursive_fwd_write_t*)ALLOCATE(sizeof(recursive_fwd_write_t),
							 recursive_fwd_write_t);
    memset(qp, 0, sizeof(recursive_fwd_write_t));
    t->extension = (void*)qp;
  }

  if (!qp->query) {
    size_t		querylen;
    /* Construct the query */
    if (!(qp->query = dns_make_question(t, t->internal_id, t->qtype, t->qname, 1, &querylen)))
      return dnserror(t, DNS_RCODE_FORMERR, querylen);

    qp->querylength = querylen;
    qp->querywritten = 0;
    qp->querylenwritten = 0;
    qp->retries = 0;
  }
  return TASK_COMPLETED;
}

static taskexec_t
__recursive_fwd_write_udp(TASK *t, void *data) {
  char			*query = NULL;					/* Query message */
  size_t		querylen = 0;					/* Length of 'query' */
  int			rv = 0, fd = -1;
  recursive_fwd_write_t	*querypacket = NULL;
  taskexec_t		res = TASK_FAILED;

  Warnx(_("DEBUG __recursive_fwd_write_udp: ENTRY for %s"), desctask(t));

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP"), desctask(t));
#endif

  if (!udp_recursive_master) {
    Warnx(_("DEBUG __recursive_fwd_write_udp: No udp_recursive_master!"));
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP - no recursion master give up task"), desctask(t));
#endif
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  Warnx(_("DEBUG __recursive_fwd_write_udp: udp_recursive_master status=%d, NEED_RECURSIVE_FWD_CONNECT=%d"),
        udp_recursive_master->status, NEED_RECURSIVE_FWD_CONNECT);

  if (udp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECT) {
    Warnx(_("DEBUG __recursive_fwd_write_udp: Master still connecting, returning TASK_CONTINUE"));
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP - still waiting for connect try again later"), desctask(t));
#endif
    return TASK_CONTINUE;
  }

  Warnx(_("DEBUG __recursive_fwd_write_udp: Calling __recursive_fwd_setup_query"));
  res = __recursive_fwd_setup_query(t, &querypacket);
  Warnx(_("DEBUG __recursive_fwd_write_udp: __recursive_fwd_setup_query returned %d (TASK_COMPLETED=%d)"),
        res, TASK_COMPLETED);
  if (res != TASK_COMPLETED) {
    Warnx(_("DEBUG __recursive_fwd_write_udp: Query setup failed, returning %d"), res);
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP - query setup failed"), desctask(t));
#endif
    return res;
  }

  query = &querypacket->query[querypacket->querywritten];
  querylen = querypacket->querylength - querypacket->querywritten;

  fd = recursive_udp_fd;

  Warnx(_("DEBUG __recursive_fwd_write_udp: About to send %d bytes to fd=%d"), querylen, fd);
  rv = send(fd, query, querylen, MSG_DONTWAIT|MSG_EOR);
  Warnx(_("DEBUG __recursive_fwd_write_udp: send() returned %d"), rv);
  if (rv < 0) {
    Warnx(_("DEBUG __recursive_fwd_write_udp: send() failed with errno=%d (%s)"), errno, strerror(errno));
    if (
	(errno == EINTR)
#ifdef EAGAIN
	|| (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	|| (errno == EWOULDBLOCK)
#endif
#endif
	) {
      Warn(_("%s: udp fd %d to %s is not ready to write, will retry"), desctask(t), fd,
	   recursive_fwd_server);
      return TASK_CONTINUE;
    }
    Warn("%s: %s %s", desctask(t),
 	 _("error sending question to recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  if (querylen - rv > 0) {
    querypacket->querywritten += rv;
    t->status = NEED_RECURSIVE_FWD_WRITE;
    t->timeout = current_time + _recursive_timeout(t, querypacket);
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP - sent partial packet try again later"), desctask(t));
#endif
    return TASK_CONTINUE;
  } else {
    t->status = NEED_RECURSIVE_FWD_RETRY;
    t->timeout = current_time + _recursive_timeout(t, querypacket);
    querypacket->querywritten = 0;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() UDP - sent full packet retry if no reply by timeout"), desctask(t));
#endif
    return TASK_CONTINUE;
  }
}

static taskexec_t
__recursive_fwd_write_tcp(TASK *t, void *data) {
  char			*query = NULL;					/* Query message */
  size_t		querylen = 0;					/* Length of 'query' */
  int			rv = 0, fd = -1;
  recursive_fwd_write_t	*querypacket = NULL;
  taskexec_t		res = TASK_FAILED;

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_write() TCP"), desctask(t));
#endif

  if (tcp_recursive_master == NULL) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd_write() TCP no master available"), desctask(t));
#endif
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  /* Need to check that the socket has finished connecting */
  if ((tcp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECT)
      || (tcp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECTING)) {
    /* Hopefully we won't spin too much here */
    return TASK_CONTINUE;
  }

  res = __recursive_fwd_setup_query(t, &querypacket);
  if (res != TASK_COMPLETED) return res;

  query = &querypacket->query[querypacket->querywritten];
  querylen = querypacket->querylength - querypacket->querywritten;
  
  fd = recursive_tcp_fd;

  /* Write packet length first */
  while (querypacket->querylenwritten < sizeof(uint16_t)) {
    querypacket->querylength = htons(querypacket->querylength);
    rv = send(fd, &(((char*)&querypacket->querylength)[querypacket->querylenwritten]),
	      sizeof(uint16_t) - querypacket->querylenwritten, MSG_DONTWAIT);
    querypacket->querylength = ntohs(querypacket->querylength);
    if (rv < 0) {
      if (
	  (errno == EINTR)
#ifdef EAGAIN
	  || (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	  || (errno == EWOULDBLOCK)
#endif
#endif
	  ) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
	DebugX("recursive", 1, _("%s: %s fd %d is not ready to write, will retry"),
	       desctask(t), recursive_fwd_server, fd);
#endif
	return TASK_CONTINUE;
      }
      if (errno == ECONNRESET) {
	if (__recursive_fwd_reconnect_tcp(tcp_recursive_master) == TASK_CONTINUE)
	  return TASK_CONTINUE;
      }
      Warn("%s: %s %s - %s(%d)", desctask(t),
	   _("error sending question to recursive forwarder"),
	   recursive_fwd_server, strerror(errno), errno);
      sockclose(fd);
      recursive_tcp_fd = -1;
      return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
    }
    querypacket->querylenwritten += rv;
  }

  rv = send(fd, query, querylen, MSG_DONTWAIT|MSG_EOR);
  if (rv < 0) {
    if (
	(errno == EINTR)
#ifdef EAGAIN
	|| (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	|| (errno == EWOULDBLOCK)
#endif
#endif
	) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: %s fd %d not ready to write, will retry"),
	     desctask(t), recursive_fwd_server, fd);
#endif
      return TASK_CONTINUE;
    }
    if (errno == ECONNRESET) {
	if (__recursive_fwd_reconnect_tcp(tcp_recursive_master) == TASK_CONTINUE)
	  return TASK_CONTINUE;
    }
    Warn("%s: %s %s - %s(%d)", desctask(t),
	 _("error sending question to recursive forwarder"),
	 recursive_fwd_server, strerror(errno), errno);
    sockclose(fd);
    recursive_tcp_fd = -1;
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  if (querylen - rv > 0) {
    querypacket->querywritten += rv;
    t->status = NEED_RECURSIVE_FWD_WRITE;
    t->timeout = current_time + _recursive_timeout(t, querypacket);
    return TASK_CONTINUE;
  } else {
    t->status = NEED_RECURSIVE_FWD_RETRY;
    t->timeout = current_time + _recursive_timeout(t, querypacket);
    querypacket->querywritten = 0;
    return TASK_CONTINUE;
  }
}

static int
__recursive_fwd_read(TASK *t, char *reply, int replylen) {
  uchar		*r = NULL;
  uint16_t	qdcount = 0, ancount = 0, nscount = 0, arcount = 0;
  DNS_HEADER	hdr;

  memset(&hdr, 0, sizeof(hdr));

  /* Copy reply into task */
  t->reply = ALLOCATE(replylen, char[]);

  /* Preserve incoming id rather than the recursive one */
  r = (uchar*)t->reply;
  DNS_PUT16(r, t->id);

  /* Copy rest of message across */
  memcpy(r, reply + SIZE16, replylen - SIZE16);
  t->replylen = replylen;

  /* Parse reply data into id, header, etc */
  memcpy(&hdr, r, SIZE16); r += SIZE16;
  DNS_GET16(qdcount, r);
  DNS_GET16(ancount, r);
  DNS_GET16(nscount, r);
  DNS_GET16(arcount, r);

  /* Set record counts and rcode */
  t->hdr.rcode = hdr.rcode;
  t->an.size = ancount;
  t->ns.size = nscount;
  t->ar.size = arcount;

  /* Cache these replies! */
  t->reply_cache_ok = 1;
  add_reply_to_cache(t);

  /* Record the fact that this question was forwarded to another server */
  t->forwarded = 1;

  /* Mark server as successful */
  mark_recursive_server_success();

  t->status = NEED_WRITE;

  return 0;
}

static taskexec_t
__recursive_fwd_setup_reply1(TASK *t, recursive_fwd_read_t **replypacket) {
  recursive_fwd_read_t	*rp = NULL;

  if (!replypacket)
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  *replypacket = rp = (recursive_fwd_read_t*)t->extension;

  if (!rp) {
    *replypacket = rp = (recursive_fwd_read_t*)ALLOCATE(sizeof(recursive_fwd_read_t),
							recursive_fwd_read_t);
    memset(rp, 0, sizeof(recursive_fwd_read_t));
    t->extension = (void*)rp;
  }

  return TASK_COMPLETED;
}

static taskexec_t
__recursive_fwd_setup_reply2(TASK *t, recursive_fwd_read_t **replypacket, size_t length) {
  recursive_fwd_read_t	*rp = NULL;

  if (!replypacket)
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  *replypacket = rp = (recursive_fwd_read_t*)t->extension;

  if (!rp->reply) {
    rp->reply = (char*)ALLOCATE(length, char[]);
    rp->replylength = length;
  }

  return TASK_COMPLETED;
}

static taskexec_t
__recursive_fwd_setup_reply(TASK *t, recursive_fwd_read_t **replypacket) {
  taskexec_t		res = __recursive_fwd_setup_reply1(t, replypacket);

  if (res != TASK_COMPLETED) return res;

  res = __recursive_fwd_setup_reply2(t, replypacket, DNS_MAXPACKETLEN_UDP);

  return res;
}

static taskexec_t
__recursive_fwd_read_udp(TASK *t, void *data) {
  char			*reply = NULL;
  uint16_t		replylen = 0;
  int			rv = 0;
  int			i = 0;
  uchar			*src = NULL;
  uint16_t		id = 0;
  TASK			*realT = NULL;
  recursive_fwd_read_t	*replypacket = NULL;
  taskexec_t		res = TASK_FAILED;
  int			fd = -1;

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_read() UDP"), desctask(t));
#endif

  res = __recursive_fwd_setup_reply(t, &replypacket);
  if (res != TASK_COMPLETED) return res;
  
  reply = &replypacket->reply[replypacket->replyread];
  replylen = replypacket->replylength - replypacket->replyread;

  fd = t->fd;

  if ((rv = recv(fd, reply, replylen, MSG_DONTWAIT)) < 0) {
    if (
	(errno == EINTR)
#ifdef EAGAIN
	|| (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	|| (errno == EWOULDBLOCK)
#endif
#endif
	) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: %s fd %d is not ready to read, will retry"), desctask(t),
	     recursive_fwd_server, fd);
#endif
      return TASK_CONTINUE;
    }
    Warn("%s: %s %s - %s(%d)", desctask(t),_("error reading reply from recursive forwarder"),
	 recursive_fwd_server, strerror(errno), errno);
    return TASK_FAILED;
  }

  if (rv == 0) {
    t->extension = NULL;
    RELEASE(replypacket);
    RELEASE(reply);
    Warnx("%s: %s %s", desctask(t), _("no reply from recursive forwarder connection failed"),
	  recursive_fwd_server);
    return TASK_FAILED;
  }

  replypacket->replyread += rv;
  replylen -= rv;

  if(replypacket->replylength < DNS_HEADERSIZE) {
    RELEASE(reply);
    RELEASE(replypacket);
    t->extension = NULL;
    Warn("%s: %s", recursive_fwd_server,  _("short message from recursive server"));
    return TASK_FAILED;
  }

  /* Find the corresponding task on the PERIODIC queue for this operation */
  src = (uchar*)reply;
  DNS_GET16(id, src);

  for (i = HIGH_PRIORITY_TASK; i <= LOW_PRIORITY_TASK; i++) {
    if ((realT = task_find_by_id(t, TaskArray[PERIODIC_TASK][i], id))) break;
  }

  t->extension = NULL;

  if (realT) {
    __recursive_fwd_read(realT, reply, replypacket->replylength);
    /* Move task back to NORMAL Q */
    task_change_type(realT, NORMAL_TASK);
    udp_recursion_running--;
    RELEASE(reply);
    RELEASE(replypacket);
  } else {
    RELEASE(reply);
    RELEASE(replypacket);
    Warn("%s: %s", recursive_fwd_server, _("Reply to unknown request"));
    return TASK_FAILED;
  }

#ifdef notdef
  if (udp_recursion_running <= 0) {
    udp_recursion_running = 0;
    return TASK_COMPLETED; /* Finished with this master task for now */
  } else {
#endif
    return TASK_CONTINUE; /* Try to read again ... */
#ifdef notdef
  }
#endif
}

static taskexec_t
__recursive_fwd_read_tcp(TASK *t, void *data) {
  char			*reply = NULL;
  uint16_t		replylen = 0;
  int			rv = 0;
  int			i = 0;
  uchar			*src = NULL;
  uint16_t		id = 0;
  TASK			*realT = NULL;
  recursive_fwd_read_t	*replypacket = NULL;
  taskexec_t		res = TASK_FAILED;
  int			fd = -1;

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_read() TCP"), desctask(t));
#endif

  res = __recursive_fwd_setup_reply1(t, &replypacket);
  if (res != TASK_COMPLETED) return res;

  fd = t->fd;

  if (!replypacket->replylenread) {
    while (replypacket->replylenread < sizeof(uint16_t)) {
      rv = recv(fd, &(((char*)&replypacket->replylength)[replypacket->replylenread]),
		sizeof(uint16_t) - replypacket->replylenread, MSG_DONTWAIT);
      if (rv < 0) {
	if (
	    (errno == EINTR)
#ifdef EAGAIN
	    || (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	    || (errno == EWOULDBLOCK)
#endif
#endif
	    ) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
	  DebugX("recursive", 1, _("%s: %s fd %d is not ready to read will retry"), desctask(t),
		 recursive_fwd_server, fd);
#endif
	  return TASK_CONTINUE;
	}
	if (errno == ECONNRESET) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
	  DebugX("recursive", 1, _("%s: connection reset by %s fd %d - reconnect and retry"), desctask(t),
		 recursive_fwd_server, fd);
#endif
	  if(__recursive_fwd_reconnect_read(t) == TASK_CONTINUE) {
	    fd = t->fd = recursive_tcp_fd;
	    replypacket->replylenread = 0;
	    RELEASE(replypacket->reply);
	    t->status = NEED_RECURSIVE_FWD_CONNECT;
	    return TASK_CONTINUE;
	  }
	}
	Warnx(_("%s: tcp receive length failed with %s"), desctask(t), strerror(errno));
	sockclose(recursive_tcp_fd);
	recursive_tcp_fd = -1;
	t->fd = -1;
	return TASK_FAILED;
      }
      if (rv == 0) {
	Warnx(_("%s: tcp receive length zero"), desctask(t));
	sockclose(recursive_tcp_fd);
	recursive_tcp_fd = -1;
	t->fd = -1;
	return TASK_FAILED;
      }
      replypacket->replylenread += rv;
    }

    res = __recursive_fwd_setup_reply2(t, &replypacket, ntohs(replypacket->replylength));
  }

  reply = &replypacket->reply[replypacket->replyread];
  replylen = replypacket->replylength - replypacket->replyread;

  if ((rv = recv(fd, reply, replylen, MSG_DONTWAIT)) < 0) {
    if (
	(errno == EINTR)
#ifdef EAGAIN
	|| (errno == EAGAIN)
#else
#ifdef EWOULDBLOCK
	|| (errno == EWOULDBLOCK)
#endif
#endif
	) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: %s fd %d is not ready to read, will retry"), desctask(t),
	     recursive_fwd_server, fd);
#endif
      return TASK_CONTINUE;
    }
    if (errno == ECONNRESET) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: connection reset by %s fd %d - reconnect and retry"), desctask(t),
	     recursive_fwd_server, fd);
#endif
      if (__recursive_fwd_reconnect_read(t) == TASK_CONTINUE) {
	fd = t->fd = recursive_tcp_fd;
	replypacket->replylenread = 0;
	RELEASE(reply);
	t->status = NEED_RECURSIVE_FWD_CONNECT;
	return TASK_CONTINUE;
      }
    }
    Warn("%s: %s - %s", recursive_fwd_server, _("error reading reply from recursive forwarder"),
	 strerror(errno));
    sockclose(recursive_tcp_fd);
    recursive_tcp_fd = -1;
    t->fd = -1;
    return TASK_FAILED;
  }

  if (rv == 0) {
    t->extension = NULL;
    RELEASE(replypacket);
    RELEASE(reply);
    Warnx("%s: %s", recursive_fwd_server, _("no reply from recursive forwarder connection failed"));
    if (__recursive_fwd_reconnect_tcp(t) == TASK_CONTINUE) {
      t->fd = recursive_tcp_fd;
      t->status = NEED_RECURSIVE_FWD_CONNECT;
      return TASK_CONTINUE;
    }
    sockclose(recursive_tcp_fd);
    recursive_tcp_fd = -1;
    t->fd = -1;
    return TASK_FAILED;
  }

  replypacket->replyread += rv;
  replylen -= rv;

  if (replylen > 0) return TASK_CONTINUE;

  if(replypacket->replylength < DNS_HEADERSIZE) {
    RELEASE(reply);
    Warn("%s: %s", recursive_fwd_server,  _("short message from recursive server"));
    return TASK_FAILED;
  }

  /* Find the corresponding task on the PERIODIC queue for this operation */
  src = (uchar*)reply;
  DNS_GET16(id, src);

  for (i = HIGH_PRIORITY_TASK; i <= LOW_PRIORITY_TASK; i++) {
    if ((realT = task_find_by_id(t, TaskArray[PERIODIC_TASK][i], id))) break;
  }

  t->extension = NULL;

  if (realT) {
    __recursive_fwd_read(realT, reply, replypacket->replylength);
  /* Move task back to IO Q */
    task_change_type(realT, IO_TASK); 
    tcp_recursion_running--;
    RELEASE(reply);
    RELEASE(replypacket);
  } else {
    RELEASE(reply);
    RELEASE(replypacket);
    Warn("%s: %s", recursive_fwd_server, _("Reply to unknown request"));
    return TASK_FAILED;
  }

#ifdef notdef
  if (tcp_recursion_running <= 0) {
    tcp_recursion_running = 0;
    return TASK_COMPLETED; /* Finished with this master task for now */
  } else {
#endif
    return TASK_CONTINUE; /* Try to read again ... */
#ifdef notdef
  }
#endif
}

static taskexec_t
__recursive_fwd_udp(TASK *t) {
  QUEUE **connectQ = NULL;

  Warnx(_("DEBUG: __recursive_fwd_udp() ENTRY for %s"), t->qname);

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd() protocol = UDP"), desctask(t));
#endif

  t->status = NEED_RECURSIVE_FWD_WRITE;

  if (!udp_recursive_master) {
    taskexec_t		rv = TASK_FAILED;
    struct sockaddr	*rsa = NULL;

    sockclose(recursive_udp_fd);
    rv = __recursive_start_comms(t, &recursive_udp_fd, SOCK_DGRAM);

    if (rv != TASK_COMPLETED) return rv;

    (void)get_serveraddr(&rsa);

    udp_recursive_master = IOtask_init(t->priority, NEED_RECURSIVE_FWD_CONNECT,
				       recursive_udp_fd,
				       SOCK_DGRAM, recursive_family, rsa);
    Warnx(_("DEBUG: Created udp_recursive_master task, status=%d, fd=%d"),
          udp_recursive_master->status, udp_recursive_master->fd);

    connectQ = ALLOCATE(sizeof(connectQ), QUEUE*);
    *connectQ = queue_init("recursive", "udp");
    task_add_extension(udp_recursive_master, connectQ, __recursive_fwd_read_free,
		       __recursive_fwd_read_udp, __recursive_fwd_read_timeout);

  }

  task_change_type(t, PERIODIC_TASK);
  t->timeout = current_time;
  udp_recursive_master->timeout = current_time + 120;

  if (udp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECT
      || udp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECTING) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd() queuing task while waiting for connect"), desctask(t));
#endif
    connectQ = (QUEUE**)(udp_recursive_master->extension);
    requeue(connectQ, t);
    t->status = NEED_RECURSIVE_FWD_CONNECTED;
  }
  task_add_extension(t, NULL, __recursive_fwd_write_free,
		     __recursive_fwd_write_udp, __recursive_fwd_write_timeout);

  udp_recursion_running++;

  Warnx(_("DEBUG: __recursive_fwd_udp() EXIT returning TASK_EXECUTED for %s"), t->qname);
  return TASK_EXECUTED;
}

static taskexec_t
__recursive_fwd_tcp(TASK *t) {
  QUEUE **connectQ = NULL;

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd() protocol = TCP"), desctask(t));
#endif

  t->status = NEED_RECURSIVE_FWD_WRITE;

  if (!tcp_recursive_master) {
    taskexec_t		rv = TASK_FAILED;
    struct sockaddr	*rsa = NULL;

    sockclose(recursive_tcp_fd);
    rv = __recursive_start_comms(t, &recursive_tcp_fd, SOCK_STREAM);

    if (rv != TASK_COMPLETED) return rv;

    (void)get_serveraddr(&rsa);

    tcp_recursive_master = IOtask_init(t->priority, NEED_RECURSIVE_FWD_CONNECT,
				       recursive_tcp_fd,
				       SOCK_STREAM, recursive_family, rsa);
    connectQ = ALLOCATE(sizeof(connectQ), QUEUE*);
    *connectQ = queue_init("recursive", "tcp");
    task_add_extension(tcp_recursive_master, connectQ, __recursive_fwd_read_free,
		       __recursive_fwd_read_tcp, __recursive_fwd_read_timeout);
  }

  task_change_type(t, PERIODIC_TASK);
  t->timeout = current_time;
  tcp_recursive_master->timeout = current_time + 120;

  if (tcp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECT
      || tcp_recursive_master->status == NEED_RECURSIVE_FWD_CONNECTING) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
    DebugX("recursive", 1, _("%s: recursive_fwd() queuing task while waiting for connect"), desctask(t));
#endif
    connectQ = (QUEUE**)(tcp_recursive_master->extension);
    requeue(connectQ, t);
    t->status = NEED_RECURSIVE_FWD_CONNECTED;
  }
  task_add_extension(t, NULL, __recursive_fwd_write_free,
		     __recursive_fwd_write_tcp, __recursive_fwd_write_timeout);

  tcp_recursion_running++;

  return TASK_EXECUTED;
}

taskexec_t
recursive_fwd(TASK *t) {

  switch (t->protocol) {

  case SOCK_DGRAM:	return __recursive_fwd_udp(t);
  case SOCK_STREAM:	return __recursive_fwd_tcp(t);

  default:		return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  }
}
/*--- recursive_fwd() ---------------------------------------------------------------------------*/


/**************************************************************************************************
	RECURSIVE_FWD_CONNECT
	Open connection to recursive forwarder.
	XXX: Will this connect() ever block?
**************************************************************************************************/
static taskexec_t
__recursive_fwd_connect_udp(TASK *t) {
  int			rv = 0;
  struct sockaddr	*rsa = NULL;
  socklen_t		rsalen = get_serveraddr(&rsa);
  int			fd = -1;
  QUEUE			**connectQ = NULL;

  Warnx(_("DEBUG: __recursive_fwd_connect_udp() ENTRY for %s"), desctask(t));

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_connect() UDP"), desctask(t));
#endif

  fd = recursive_udp_fd;

  if ((rv = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)) < 0) {
    Warn("%s: %s %s", desctask(t), _("error setting non-blocking mode for recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  if ((rv = connect(fd, rsa, rsalen)) < 0) {
    Warnx(_("DEBUG __recursive_fwd_connect_udp: connect() failed with errno=%d (%s)"), errno, strerror(errno));
    Warn("%s: %s %s", desctask(t), _("error connecting to recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  Warnx(_("DEBUG __recursive_fwd_connect_udp: connect() SUCCESS"));

  t->status = NEED_RECURSIVE_FWD_READ;
  t->timeout = current_time + 120;

  assert(t == udp_recursive_master);

  connectQ = (QUEUE**)(t->extension);
  Warnx(_("DEBUG __recursive_fwd_connect_udp: About to restore queued tasks, connectQ=%p"), connectQ);
  if (connectQ && *connectQ && (*connectQ)->head) {
    Warnx(_("DEBUG __recursive_fwd_connect_udp: connectQ is not NULL, *connectQ=%p, head=%p"),
          *connectQ, (*connectQ)->head);

    /* Move all waiting tasks from connectQ back to TaskArray for processing */
    /* Use safe iteration - get task, save next, then move */
    TASK *queryt = (*connectQ)->head;
    while (queryt) {
      TASK *next_task = queryt->next;  /* Save next pointer BEFORE requeueing */

      Warnx(_("DEBUG __recursive_fwd_connect_udp: Restoring task %s"), desctask(queryt));
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: recursive_fwd_connect() restoring task after connect"), desctask(queryt));
#endif

      queryt->status = NEED_RECURSIVE_FWD_WRITE;
      queryt->timeout = current_time;

      Warnx(_("DEBUG __recursive_fwd_connect_udp: Task %s status=%d, calling requeue"),
            desctask(queryt), queryt->status);

      /* Requeue before changing type - requeue() needs current type to remove from correct queue */
      requeue(&TaskArray[NORMAL_TASK][queryt->priority], queryt);
      queryt->type = NORMAL_TASK;  /* Update type after requeue */

      Warnx(_("DEBUG __recursive_fwd_connect_udp: Task %s requeued successfully"), desctask(queryt));

      /* Move to next task using saved pointer */
      queryt = next_task;
    }
    Warnx(_("DEBUG __recursive_fwd_connect_udp: All tasks restored, releasing connectQ"));
    RELEASE(*connectQ);
    RELEASE(connectQ);
    t->extension = NULL;
  }

  Warnx(_("DEBUG __recursive_fwd_connect_udp: Returning TASK_CONTINUE"));
  return TASK_CONTINUE;
}

static taskexec_t
__recursive_fwd_connect_tcp(TASK *t) {
  int			rv = 0;
  struct sockaddr	*rsa = NULL;
  socklen_t		rsalen = get_serveraddr(&rsa);
  int			fd = -1;
  QUEUE			**connectQ = NULL;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_connect() TCP"), desctask(t));
#endif

  fd = recursive_tcp_fd;

  if ((rv = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)) < 0) {
    Warn("%s: %s %s", desctask(t), _("error setting non-blocking mode for recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }


  if ((rv = connect(fd, rsa, rsalen)) < 0) {
    if (errno == EINPROGRESS) {
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: connect returns EINPROGRESS"), desctask(t));
#endif
      /* Set up timeout so that reconnect is attempted */
      t->timeout = current_time + recursion_connect_timeout;
      t->status = NEED_RECURSIVE_FWD_CONNECTING;
      return TASK_CONTINUE;
    }
    Warn("%s: %s %s", desctask(t), _("error connecting to recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  t->status = NEED_RECURSIVE_FWD_READ;
  t->timeout = current_time + 120;

  assert(t == tcp_recursive_master);

  connectQ = (QUEUE**)(t->extension);
  if (connectQ) {
    while ((*connectQ)->head) {
      TASK *queryt = (*connectQ)->head;
      taskexec_t write_res;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: recursive_fwd_connect() restoring task after connect"), desctask(queryt));
#endif
      queryt->status = NEED_RECURSIVE_FWD_WRITE;
      queryt->timeout = current_time;

      /* Dequeue from connectQ and immediately write the query to upstream DNS */
      dequeue(queryt);
      write_res = recursive_fwd_write(queryt);
    }
    RELEASE(*connectQ);
    RELEASE(connectQ);
    t->extension = NULL;
  }

  return TASK_CONTINUE;
}

static taskexec_t
__recursive_fwd_connecting_tcp(TASK *t) {
  int			rv = 0;
  int			fd = -1;
  int			errorcode = 0;
  socklen_t		errorlength = sizeof(errorcode);
  QUEUE			**connectQ = NULL;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: recursive_fwd_connecting() TCP connect completed"), desctask(t));
#endif
  fd = recursive_tcp_fd;

  rv = getsockopt(fd, SOL_SOCKET, SO_ERROR, &errorcode, &errorlength);

  if (rv < 0) {
    Warn("%s: %s %s", desctask(t), _("error getting socket options while connecting to recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

#if DEBUG_ENABLED && DEBUG_RECURSIVE
  DebugX("recursive", 1, _("%s: connect completion result = %s(%d)"), desctask(t), strerror(errorcode), errorcode);
#endif
  if (errorcode) {
    Warn("%s: %s %s", desctask(t), _("error connecting to recursive forwarder"),
	 recursive_fwd_server);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_FWD_RECURSIVE);
  }

  t->status = NEED_RECURSIVE_FWD_READ;
  t->timeout = current_time + 120;

  assert(t == tcp_recursive_master);

  connectQ = (QUEUE**)(t->extension);
  if (connectQ) {
    while ((*connectQ)->head) {
      TASK *queryt = (*connectQ)->head;
      taskexec_t write_res;
#if DEBUG_ENABLED && DEBUG_RECURSIVE
      DebugX("recursive", 1, _("%s: recursive_fwd_connect() restoring task after connect"), desctask(queryt));
#endif
      queryt->status = NEED_RECURSIVE_FWD_WRITE;
      queryt->timeout = current_time;

      /* Dequeue from connectQ and immediately write the query to upstream DNS */
      dequeue(queryt);
      write_res = recursive_fwd_write(queryt);
    }
    RELEASE(*connectQ);
    RELEASE(connectQ);
    t->extension = NULL;
  }

  return TASK_CONTINUE;
}

taskexec_t
recursive_fwd_connect(TASK *t) {

  Warnx(_("DEBUG: recursive_fwd_connect() ENTRY, status=%d, protocol=%d, fd=%d"),
        t->status, t->protocol, t->fd);

  switch (t->protocol) {

  case SOCK_DGRAM:
    Warnx(_("DEBUG: recursive_fwd_connect() SOCK_DGRAM case, calling __recursive_fwd_connect_udp()"));
    return __recursive_fwd_connect_udp(t);
  case SOCK_STREAM:
    Warnx(_("DEBUG: recursive_fwd_connect() SOCK_STREAM case, calling __recursive_fwd_connect_tcp()"));
    return __recursive_fwd_connect_tcp(t);

  default:
    Warnx(_("DEBUG: recursive_fwd_connect() DEFAULT case - unknown protocol %d"), t->protocol);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  }
}

taskexec_t
recursive_fwd_connecting(TASK *t) {

  switch (t->protocol) {

  case SOCK_DGRAM:	return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);
  case SOCK_STREAM:	return __recursive_fwd_connecting_tcp(t);

  default:		return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  }
}

/*--- recursive_fwd_connect() -------------------------------------------------------------------*/


/**************************************************************************************************
	RECURSIVE_FWD_WRITE
	Write question to recursive forwarder.
**************************************************************************************************/
taskexec_t
recursive_fwd_write(TASK *t) {

  Warnx(_("DEBUG recursive_fwd_write: ENTRY for %s, protocol=%d, status=%d"),
        desctask(t), t->protocol, t->status);

  switch (t->protocol) {

  case SOCK_DGRAM:
    Warnx(_("DEBUG recursive_fwd_write: SOCK_DGRAM case, calling __recursive_fwd_write_udp"));
    return __recursive_fwd_write_udp(t, NULL);
  case SOCK_STREAM:
    Warnx(_("DEBUG recursive_fwd_write: SOCK_STREAM case, calling __recursive_fwd_write_tcp"));
    return __recursive_fwd_write_tcp(t, NULL);

  default:
    Warnx(_("DEBUG recursive_fwd_write: DEFAULT case - unknown protocol %d"), t->protocol);
    return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  }
}
/*--- recursive_fwd_write() ---------------------------------------------------------------------*/


/**************************************************************************************************
	RECURSIVE_FWD_READ
	Reads question from recursive forwarder.
	Returns -1 on error, 0 on success, 1 on "try again".
**************************************************************************************************/
taskexec_t
recursive_fwd_read(TASK *t) {

  switch (t->protocol) {

  case SOCK_DGRAM:		return __recursive_fwd_read_udp(t, NULL);
  case SOCK_STREAM:		return __recursive_fwd_read_tcp(t, NULL);

  default:			return dnserror(t, DNS_RCODE_SERVFAIL, ERR_INTERNAL);

  }
}
/*--- recursive_fwd_read() ----------------------------------------------------------------------*/

/* vi:set ts=3: */
/* NEED_PO */
