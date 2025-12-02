##
##  $Id: Makefile.am,v 1.26 2005/04/20 16:43:22 bboy Exp $
##

noinst_LIBRARIES	=	libmydns.a
INCLUDES		=	@INTLINCLUDE@ @UTILINCLUDE@ @SQLINCLUDE@
noinst_HEADERS		=	bits.h header.h mydns.h geoip.h axfr.h memzone.h tsig.h dnsupdate.h dnssec.h zone-masters-conf.h dns-cache.h doh.h
libmydns_a_SOURCES	=	conf.c db.c ip.c rr.c soa.c sql.c str.c unencode.c geoip.c axfr.c memzone.c tsig.c dnsupdate.c dnssec.c zone-masters-conf.c dns-cache.c doh.c

ctags:
	ctags @UTILDIR@/*.[ch] *.[ch]

##  vi:set ts=3:
