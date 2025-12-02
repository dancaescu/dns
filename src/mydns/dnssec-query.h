/*
 * dnssec-query.h - DNSSEC query response integration header
 * Date: 2025-11-28
 */

#ifndef _MYDNS_DNSSEC_QUERY_H
#define _MYDNS_DNSSEC_QUERY_H

#include "named.h"

/*
 * Add DNSSEC records (RRSIG, DNSKEY) to query response
 * Call this after adding regular RRs to the response
 *
 * Parameters:
 *   t - Task structure
 *   section - Which section to add to (ANSWER, AUTHORITY, ADDITIONAL)
 *   zone_id - Zone ID from soa table
 *   zone_name - Zone name (e.g., "example.com.")
 *   rrset_name - RRset owner name
 *   rrset_type - RRset type (A, AAAA, MX, etc.)
 */
void dnssec_add_to_response(TASK *t, datasection_t section, uint32_t zone_id,
                            const char *zone_name, const char *rrset_name,
                            dns_qtype_t rrset_type);

/*
 * Add NSEC3 proof for NXDOMAIN response
 * Call this when returning NXDOMAIN (name not found)
 *
 * Parameters:
 *   t - Task structure
 *   zone_id - Zone ID from soa table
 *   zone_name - Zone name
 *   qname - Query name that doesn't exist
 */
void dnssec_add_nxdomain_proof(TASK *t, uint32_t zone_id, const char *zone_name,
                               const char *qname);

#endif /* _MYDNS_DNSSEC_QUERY_H */
