#!/usr/bin/env python3
"""dev-test/check_wav.py — parse an AETHER CURRENTS exported WAV and print its
RIFF LIST-INFO tags, proving IART/ICOP (with the attribution notice) are
embedded correctly. No third-party deps (stdlib `wave` doesn't expose LIST
chunks, so this walks the RIFF structure by hand).

Usage: python3 dev-test/check_wav.py path/to/aether-currents_*.wav
"""
import struct
import sys


def read_chunks(data, start, end):
    off = start
    chunks = []
    while off + 8 <= end:
        cid = data[off:off + 4].decode('ascii', errors='replace')
        size = struct.unpack_from('<I', data, off + 4)[0]
        body_start = off + 8
        chunks.append((cid, body_start, size))
        off = body_start + size
        if size % 2 == 1:
            off += 1  # word alignment pad byte
    return chunks


def parse_list_info(data, body_start, size):
    end = body_start + size
    list_type = data[body_start:body_start + 4].decode('ascii', errors='replace')
    tags = {}
    if list_type != 'INFO':
        return list_type, tags
    off = body_start + 4
    for cid, sub_start, sub_size in read_chunks(data, off, end):
        text = data[sub_start:sub_start + sub_size].split(b'\x00', 1)[0].decode('utf-8', errors='replace')
        tags[cid] = text
    return list_type, tags


def main():
    if len(sys.argv) < 2:
        print('usage: check_wav.py <file.wav>')
        sys.exit(1)
    path = sys.argv[1]
    with open(path, 'rb') as f:
        data = f.read()

    assert data[0:4] == b'RIFF', 'not a RIFF file'
    riff_size = struct.unpack_from('<I', data, 4)[0]
    assert data[8:12] == b'WAVE', 'not a WAVE file'

    print(f'RIFF size field: {riff_size}  (file bytes: {len(data)})')

    chunks = read_chunks(data, 12, len(data))
    found_list = False
    found_data = False
    for cid, body_start, size in chunks:
        print(f'chunk {cid!r:6} size={size}')
        if cid == 'LIST':
            found_list = True
            list_type, tags = parse_list_info(data, body_start, size)
            print(f'  LIST type={list_type}')
            for k, v in tags.items():
                print(f'  {k} = {v}')
            iart = tags.get('IART', '')
            icop = tags.get('ICOP', '')
            iprd = tags.get('IPRD', '')
            icmt = tags.get('ICMT', '')
            icrd = tags.get('ICRD', '')
            assert 'sinaida' in iart.lower(), 'IART missing Sinaida credit'
            assert 'ATTRIBUTION REQUIRED' in icop, 'ICOP missing mandatory attribution notice'
            assert 'AETHER CURRENTS' in iprd, 'IPRD missing app name'
            print('  [OK] IART present, ICOP contains "ATTRIBUTION REQUIRED"')
        if cid == 'data':
            found_data = True

    assert found_list, 'no LIST-INFO chunk found'
    assert found_data, 'no data chunk found'
    print('PASS: WAV has valid RIFF structure + LIST-INFO tags with mandatory attribution.')


if __name__ == '__main__':
    main()
