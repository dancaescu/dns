/**************************************************************************************************
	$Id: cidr.c,v 1.6 2005/04/20 16:49:11 bboy Exp $

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

#include "mydnsutil.h"

static void
prefix_to_mask(uint8_t *mask, size_t len, unsigned prefix) {
  size_t i;

  memset(mask, 0, len);
  for (i = 0; i < len && prefix; i++) {
    if (prefix >= 8) {
      mask[i] = 0xFF;
      prefix -= 8;
    } else {
      mask[i] = (uint8_t)(0xFF << (8 - prefix));
      prefix = 0;
    }
  }
}

/**************************************************************************************************
	IN_CIDR_MATCH
	Checks to see if the specified IP string is within the specified CIDR range.
	Supports both IPv4 and IPv6 CIDR notations. Returns 1 on match, 0 otherwise.
**************************************************************************************************/
int
in_cidr_match(const char *cidr, const char *ipstr) {
  unsigned char network[16], mask[16], addr[16];
  char cidr_copy[INET6_ADDRSTRLEN + 16];
  char *slash;
  int family = AF_INET;
  unsigned prefix = 0;
  size_t addrlen = 4;

  if (!cidr || !ipstr)
    return 0;

  strncpy(cidr_copy, cidr, sizeof(cidr_copy) - 1);
  cidr_copy[sizeof(cidr_copy) - 1] = '\0';

  if (!(slash = strchr(cidr_copy, '/')))
    return 0;
  *slash++ = '\0';

  if (strchr(cidr_copy, ':')) {
    family = AF_INET6;
    addrlen = 16;
  }

  if (inet_pton(family, cidr_copy, network) <= 0)
    return 0;

  if (family == AF_INET) {
    if (strchr(slash, '.')) {
      if (inet_pton(AF_INET, slash, mask) <= 0)
	return 0;
    } else {
      prefix = (unsigned)strtoul(slash, NULL, 10);
      if (prefix > 32)
	return 0;
      prefix_to_mask(mask, addrlen, prefix);
    }
  } else {
    prefix = (unsigned)strtoul(slash, NULL, 10);
    if (prefix > 128)
      return 0;
    prefix_to_mask(mask, addrlen, prefix);
  }

  if (inet_pton(family, ipstr, addr) <= 0)
    return 0;

  for (size_t i = 0; i < addrlen; i++)
    if ((addr[i] & mask[i]) != (network[i] & mask[i]))
      return 0;

  return 1;
}

/**************************************************************************************************
	Legacy IPv4-only wrapper retained for compatibility.
**************************************************************************************************/
int
in_cidr(char *cidr, struct in_addr ip) {
  char ipbuf[INET_ADDRSTRLEN];

  if (!inet_ntop(AF_INET, &ip, ipbuf, sizeof(ipbuf)))
    return 0;

  return in_cidr_match(cidr, ipbuf);
}
/*--- in_cidr() ---------------------------------------------------------------------------------*/

/* vi:set ts=3: */
