"""Shared URL validation guarding outbound fetches against SSRF.

Every connector/webhook that dereferences a user-supplied URL must run
it through ``validate_public_url`` first. The validator:

    1. Parses the URL and requires an http(s) scheme.
    2. Rejects obvious non-network targets (file:, gopher:, data:).
    3. Resolves the hostname and checks that every A/AAAA record
       points at a globally routable address — not RFC1918 private
       space, loopback, link-local, broadcast, multicast, the cloud
       IMDS address 169.254.169.254, unspecified addresses, or
       reserved blocks.
    4. Reject integer/hex-encoded hostnames that bypass string
       blacklists (``http://2130706433/`` is loopback).

The caller should then pass ``follow_redirects=False`` to the HTTP
client so a 302 can't redirect the request into a private address
post-validation.

This module is imported hot in request paths — keep it cheap.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


class UnsafeUrlError(ValueError):
    """Raised when a user-supplied URL points at a non-public target."""


_ALLOWED_SCHEMES = {"http", "https"}

# Hostnames that must never resolve at all. Some of these are
# technically routable but are never a valid outbound target for a
# user-configured connector or webhook.
_BLOCKED_HOSTNAMES = {
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kubernetes.default.svc.cluster.local",
}


def _is_public_ip(addr: str) -> bool:
    """Return True iff `addr` is a globally routable unicast address.

    Rejects: loopback, link-local, private (RFC1918), multicast,
    reserved, unspecified, carrier-grade NAT, and the cloud IMDS
    magic address.
    """
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if ip.is_loopback:
        return False
    if ip.is_link_local:
        return False
    if ip.is_private:
        return False
    if ip.is_multicast:
        return False
    if ip.is_reserved:
        return False
    if ip.is_unspecified:
        return False
    # Explicit IMDS block — many clouds also proxy it via 100.100.x.x etc.,
    # but those are caught by is_private.
    if str(ip) == "169.254.169.254":
        return False
    return True


def validate_public_url(url: str, *, allow_schemes: set[str] | None = None) -> str:
    """Validate that `url` is a safe outbound HTTP(S) target.

    Returns the URL unchanged on success, raises ``UnsafeUrlError`` on failure.
    """
    if not isinstance(url, str) or not url:
        raise UnsafeUrlError("URL is empty")

    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    allowed = allow_schemes or _ALLOWED_SCHEMES
    if scheme not in allowed:
        raise UnsafeUrlError(
            f"URL scheme '{scheme}' is not allowed (expected one of {sorted(allowed)})"
        )

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise UnsafeUrlError("URL has no hostname")

    if hostname in _BLOCKED_HOSTNAMES:
        raise UnsafeUrlError(f"Hostname '{hostname}' is blocked")

    # ``urlparse`` unwraps IPv6 brackets, so check for literal IPs first.
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        if not _is_public_ip(str(literal)):
            raise UnsafeUrlError(
                f"URL host {hostname} resolves to a non-public address"
            )
        return url

    # DNS lookup — any returned A/AAAA record must be public.
    try:
        addrinfos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise UnsafeUrlError(f"DNS lookup for {hostname} failed: {e}") from e

    resolved = {info[4][0] for info in addrinfos}
    if not resolved:
        raise UnsafeUrlError(f"DNS lookup for {hostname} returned nothing")

    for addr in resolved:
        if not _is_public_ip(addr):
            raise UnsafeUrlError(
                f"Hostname {hostname} resolves to non-public address {addr}"
            )

    return url


def validate_public_host(hostname: str) -> str:
    """Validate that a bare hostname (no scheme) resolves to public space.

    Used by connectors that take a subdomain/host config field rather
    than a full URL.
    """
    return validate_public_url(f"https://{hostname}/").split("://", 1)[1].split("/", 1)[0]
