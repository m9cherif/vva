"""Loaded automatically by Python at startup (via PYTHONPATH).

Only active when the parent sets IPV4_ONLY=1: filters DNS answers to IPv4 so
long-hanging IPv6 connects (broken IPv6 route on this host) never block yt-dlp.
"""
import os
import socket

if os.environ.get("IPV4_ONLY") == "1":
    _orig_getaddrinfo = socket.getaddrinfo

    def _getaddrinfo_ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        infos = _orig_getaddrinfo(host, port, family, type, proto, flags)
        v4 = [entry for entry in infos if entry[0] == socket.AF_INET]
        return v4 or infos

    socket.getaddrinfo = _getaddrinfo_ipv4_only
