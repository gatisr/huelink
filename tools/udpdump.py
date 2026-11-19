"""Reads a few UDP packets and prints their raw bytes.

Written to find out HOW the Hyperion udpraw/udpddp output packs 7 LEDs:
whether there is a header, in what order, how many bytes.

usage: python udpdump.py <port> <how_many_packets>
"""

import socket
import sys

port = int(sys.argv[1])
want = int(sys.argv[2]) if len(sys.argv) > 2 else 5

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", port))
s.settimeout(20)

seen = 0
while seen < want:
    try:
        data, addr = s.recvfrom(2048)
    except socket.timeout:
        print("timeout, no packets")
        break
    seen += 1
    print(f"#{seen} from {addr[0]} length={len(data)} hex={data.hex()}")
