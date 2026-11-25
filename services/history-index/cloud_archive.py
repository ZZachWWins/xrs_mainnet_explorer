"""Cloud-owned derived history; source ledger/keys/node are never modified.

Requires an operator-supplied, already verified history-index baseline. The
unchanged local L1 supplies canonicality; v4 work/Merkle ancestry is recomputed,
not producer signatures, difficulty or recovery certificates. A failed refresh
retains old public history marked stale, and disables the network-identity gate.
"""
import argparse
import base64
from collections import deque
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit
import urllib.request

import history_index as h
from wire import b58, decode, encode, octets, work_hash

ROSTER_HASH = 'a94a54b7e54ba8920674fb634f383e7cd4bf0315ffcd6d922f0b26b43c4d2da9'
ROSTER_FILE_SHA256 = '9cc06424a588a3f5e20957d423208b80814dfc5d2d3116c2fd9bb0c2ba28cda8'
STABLE_RECORDS = 1000
MAX_LINE = 4 * 1024 * 1024
MAX_FILE = 32 * 1024**3
MAX_SUFFIX_BYTES = 128 * 1024 * 1024
MAX_SUFFIX_RECORDS = 5000
MAX_RESPONSE = 4 * 1024 * 1024
MAX_ANCHOR_AGE = 120
MAX_TIP_LAG = 100
REFRESH_SECONDS = 5
OPERATION_SECONDS = 300
HASH = re.compile(r'^[0-9a-f]{64}$')
ACCOUNT_QUERY_SECONDS = 2
ACCOUNT_QUERY_VM_STEPS = 5_000_000
ACCOUNT = re.compile(r'^[1-9A-HJ-NP-Za-km-z]{32,44}$')
SIGNATURE = re.compile(r'^[1-9A-HJ-NP-Za-km-z]{64,88}$')
RECEIPT_BATCH = 4
RECEIPT_SECONDS = 4
RECEIPT_RESPONSE = 256 * 1024
RECEIPT_ID = 'xeris-archive-receipt-v1'


class CursorError(ValueError):
    def __init__(self, status):
        self.status = status
        super().__init__('Archive page expired; restart pagination.' if status == 410 else 'Invalid pagination cursor.')


class GenerationChanged(ValueError):
    """A healthy publication superseded this request's read snapshot."""


def require(value, message):
    if not value:
        raise ValueError(message)


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid JSON number')))


def opened_public(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum, 'invalid public file')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def public_bytes(path, maximum):
    with opened_public(path, maximum) as stream:
        raw = stream.read(maximum + 1)
    require(len(raw) <= maximum, 'public file exceeds bound')
    return raw


def identity(info):
    return info.st_dev, info.st_ino


def fetch_live():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            raise ValueError('native API redirect rejected')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://127.0.0.1:50008/v2/blocks?page=1&page_size=100',
                                     headers={'Accept': 'application/json', 'Cache-Control': 'no-store'})
    with opener.open(request, timeout=3) as response:
        require(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity',
                'invalid native API response')
        raw = response.read(256 * 1024 + 1)
    require(len(raw) <= 256 * 1024, 'native response exceeds bound')
    return parse(raw)


def _receipt_arguments(signature, slot):
    require(type(signature) is str and SIGNATURE.fullmatch(signature)
            and type(slot) is int and 0 < slot < 2**53, 'invalid receipt lookup')


def _receipt_http(signature, slot):
    """Disposable child: fixed local read RPC and exact block route only."""
    _receipt_arguments(signature, slot)
    def read(path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', 50008, timeout=1)
        try:
            connection.request('POST' if body else 'GET', path, body,
                {'Accept': 'application/json', 'Content-Type': 'application/json', 'Accept-Encoding': 'identity'})
            response = connection.getresponse()
            require(response.status == 200 and response.getheader('Content-Encoding', 'identity').lower() == 'identity'
                    and response.getheader('Content-Type', '').split(';', 1)[0].strip().lower() == 'application/json',
                    'native receipt response unavailable')
            declared = response.getheader('Content-Length')
            require(declared is None or declared.isascii() and declared.isdigit() and int(declared) <= RECEIPT_RESPONSE,
                    'native receipt response exceeds bound')
            raw = response.read(RECEIPT_RESPONSE + 1)
            require(0 < len(raw) <= RECEIPT_RESPONSE, 'native receipt response exceeds bound')
            return parse(raw)
        finally:
            connection.close()
    reply = read('/', json.dumps({'jsonrpc': '2.0', 'id': RECEIPT_ID, 'method': 'getTransaction',
                                 'params': [signature]}, separators=(',', ':')).encode())
    require(type(reply) is dict and set(reply) == {'jsonrpc', 'id', 'result'}
            and reply['jsonrpc'] == '2.0' and reply['id'] == RECEIPT_ID, 'invalid native receipt envelope')
    return {'receipt': reply['result'], 'block': read('/v2/block/slot/' + str(slot)) if reply['result'] is not None else None}


def fetch_receipt(signature, slot, *, deadline):
    """Hard parent deadline also covers a stalled/slow-drip local response."""
    _receipt_arguments(signature, slot)
    remaining = min(1.0, deadline - time.monotonic())
    require(math.isfinite(remaining) and remaining > 0, 'receipt batch deadline exceeded')
    request = json.dumps({'signature': signature, 'slot': slot}, separators=(',', ':')).encode()
    result = subprocess.run([sys.executable, '-E', '-s', str(Path(__file__).resolve()), '--read-receipt'],
        input=request, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining, check=False,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    require(result.returncode == 0 and 0 < len(result.stdout) <= RECEIPT_RESPONSE * 2 + 128,
            'native receipt reader unavailable')
    value = parse(result.stdout)
    require(type(value) is dict and set(value) == {'receipt', 'block'}, 'invalid native receipt reader result')
    return value


class CloudArchive:
    def __init__(self, index_path, ledger_path, roster_path, ruleset_path,
                 fetch_live=fetch_live, clock=time.time, fetch_receipt=None):
        self.path, self.roster, self.ruleset = map(Path, (ledger_path, roster_path, ruleset_path))
        index_path = Path(index_path)
        require(index_path.exists() and not index_path.is_symlink()
                and index_path.resolve() != self.path.resolve(), 'verified separate baseline required')
        self.index_path = index_path
        self.fetch_live, self.clock = fetch_live, clock
        self.fetch_receipt = fetch_receipt
        self.lock = threading.RLock()
        self.state_lock = threading.Lock()
        self.failed = True
        self.epoch = 0

    def now(self):
        now = self.clock()
        require(type(now) in (int, float) and math.isfinite(now) and now > 0, 'invalid clock')
        return now

    def metadata(self):
        require(public_bytes(self.ruleset, 64).strip() == h.CHAIN.encode(), 'wrong source ruleset')
        require(hashlib.sha256(public_bytes(self.roster, 32768)).hexdigest() == ROSTER_FILE_SHA256,
                'wrong genesis roster file')

    def read_index(self):
        # Existing Index query methods work against a query-only SQLite snapshot.
        # Public reads do not acquire the writer lock or run schema/PRAGMA writes.
        index = object.__new__(h.Index)
        index.path, index.db = self.index_path, h.readonly(self.index_path)
        return index

    @staticmethod
    def validate_cursor(index, kind, address, cursor):
        if cursor is None:
            return
        try:
            require(type(cursor) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,1024}', cursor), 'cursor encoding')
            raw = base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True)
            require(base64.urlsafe_b64encode(raw).decode().rstrip('=') == cursor, 'noncanonical cursor')
            value = parse(raw)
            integer = lambda n, minimum=0: type(n) is int and minimum <= n < 2**53
            require(type(value) is dict and set(value) == {'kind', 'address', 'revision', 'tip_slot', 'tip_hash', 'before'}
                    and value['kind'] == kind and value['address'] == address
                    and integer(value['revision']) and integer(value['tip_slot'], 1)
                    and type(value['tip_hash']) is str and HASH.fullmatch(value['tip_hash']), 'cursor shape')
            before = value['before']
            if kind == 'accounts':
                require(type(before) is list and len(before) == 2 and integer(before[0], 1)
                        and type(before[1]) is str and ACCOUNT.fullmatch(before[1])
                        and before[1] != '1' * 32, 'account cursor position')
            else:
                require(integer(before, 1) if kind == 'blocks' else type(before) is list and len(before) == 2
                        and integer(before[0], 1) and integer(before[1]) and before[1] < 4096, 'cursor position')
        except Exception:
            raise CursorError(400) from None
        anchor = index.block(value['tip_slot'])
        if value['revision'] != int(index.meta('revision') or 0) or not anchor or anchor['hash'] != value['tip_hash']:
            raise CursorError(410)

    def source_matches(self, stream, captured_identity, size):
        opened, current = os.fstat(stream.fileno()), self.path.stat(follow_symlinks=False)
        require(stat.S_ISREG(current.st_mode) and identity(opened) == identity(current) == captured_identity
                and size <= opened.st_size <= MAX_FILE and size <= current.st_size <= MAX_FILE,
                'source replaced or truncated')

    @staticmethod
    def hash_prefix(stream, size, deadline):
        stream.seek(0)
        digest = hashlib.sha256()
        remaining = size
        while remaining:
            require(time.monotonic() < deadline, 'prefix audit timed out')
            raw = stream.read(min(1024 * 1024, remaining))
            require(raw, 'source prefix truncated')
            digest.update(raw)
            remaining -= len(raw)
        return digest

    @staticmethod
    def checkpoint_detail(block):
        transactions = []
        for tx in block['transactions']:
            parsed, _ = decode(encode(tx))
            # Included is deliberately not execution-confirmed. Raw instructions
            # and their amounts remain available without invented transfer totals.
            transactions.append({'signature': parsed['signature'], 'block_slot': block['slot'],
                                 'from': parsed['signer'], 'to': '', 'tx_type': 'transaction',
                                 'status': 'included', 'details': {'instructions': parsed['instructions']}})
        return {'slot': block['slot'], 'hash': octets(block['hash'], 32).hex(), 'nonce': block['nonce'],
                'proposer': b58(octets(block['proposer'], 32)), 'poh_timestamp': block['poh_timestamp'],
                'merkle_root': octets(block['merkle_root'], 32).hex(),
                'transaction_count': len(transactions), 'transactions': transactions}

    def initialize(self):
        """Derive a stable byte anchor only from the supplied verified baseline."""
        with self.lock:
            self.metadata()
            index = h.Index(self.index_path)
            try:
                require(index.block(h.CHECKPOINT_SLOT)['hash'] == h.CHECKPOINT_HASH, 'wrong baseline checkpoint')
                existing = index.meta('cloud_anchor')
                if existing:
                    return parse(existing)
                prefix = parse(index.meta('ledger_prefix') or 'null')
                require(type(prefix) is dict and prefix.get('prefix_rehashed') is True
                        and type(prefix.get('records')) is int and prefix['records'] > STABLE_RECORDS
                        and prefix.get('header_commitments_recomputed') == prefix['records']
                        and type(prefix.get('bytes')) is int and 0 < prefix['bytes'] <= MAX_FILE,
                        'verified baseline prefix evidence required')
                boundary = prefix['records'] - STABLE_RECORDS
                digest, count, anchor, checkpoint = hashlib.sha256(), 0, None, None
                deadline = time.monotonic() + OPERATION_SECONDS
                with opened_public(self.path, MAX_FILE) as stream:
                    captured_identity = identity(os.fstat(stream.fileno()))
                    while stream.tell() < prefix['bytes']:
                        require(time.monotonic() < deadline, 'baseline initialization timed out')
                        offset = stream.tell()
                        raw = stream.readline(MAX_LINE + 1)
                        require(raw.endswith(b'\n') and len(raw) <= MAX_LINE
                                and stream.tell() <= prefix['bytes'], 'invalid baseline record')
                        digest.update(raw)
                        block = parse(raw)
                        old = index.block(block['slot'])
                        require(old and old['hash'] == octets(block['hash'], 32).hex(), 'baseline source mismatch')
                        count += 1
                        if count == boundary:
                            anchor = {'slot': block['slot'], 'hash': old['hash'], 'bytes': stream.tell(),
                                      'sha256': digest.hexdigest(), 'records': count}
                        if block['slot'] == h.CHECKPOINT_SLOT:
                            checkpoint = {'data': self.checkpoint_detail(block), 'offset': offset,
                                          'length': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                    require(count == prefix['records'] and digest.hexdigest() == prefix['sha256']
                            and anchor and checkpoint, 'baseline prefix proof mismatch')
                    require(self.hash_prefix(stream, prefix['bytes'], deadline).hexdigest() == digest.hexdigest(),
                            'baseline prefix changed during initialization')
                    self.source_matches(stream, captured_identity, prefix['bytes'])
                with h.atomic(index.db):
                    index.setmeta('cloud_anchor', h.canonical(anchor))
                    index.setmeta('cloud_checkpoint', h.canonical(checkpoint))
                    if not index.meta('cloud_generation'):
                        # Preserve an accessible immutable-history baseline even
                        # if the first live refresh cannot reach the native API.
                        # Zero explicitly means no live verification time yet.
                        baseline = {'tip': {'slot': block['slot'], 'hash': old['hash']},
                                    'verified_at_ms': 0, 'anchor_slot': None, 'anchor_hash': None,
                                    'source_identity': list(captured_identity), 'source_bytes': prefix['bytes']}
                        baseline['id'] = hashlib.sha256(h.canonical(baseline).encode()).hexdigest()
                        index.setmeta('cloud_generation', h.canonical(baseline))
                        index.setmeta('cloud_coverage', h.canonical(index.coverage()))
                return anchor
            finally:
                index.close()

    def match_live(self, index):
        value = self.fetch_live()
        require(type(value) is dict and value.get('success') is True, 'native API unavailable')
        rows = value.get('data')
        # Retain overlap while the node advances during background refreshes.
        # The completed overlap still must match by hash and be <=120s old.
        require(type(rows) is list and 2 <= len(rows) <= 100, 'native API lacks completed anchor')
        for row in rows:
            require(type(row) is dict and type(row.get('slot')) is int and 0 < row['slot'] < 2**53
                    and type(row.get('hash')) is str and HASH.fullmatch(row['hash']), 'invalid native block')
        require(all(a['slot'] > b['slot'] for a, b in zip(rows, rows[1:])), 'unordered native feed')
        tip = index.db.execute('SELECT slot,hash FROM blocks ORDER BY slot DESC LIMIT 1').fetchone()
        require(tip and abs(tip['slot'] - rows[0]['slot']) <= MAX_TIP_LAG, 'archive/native tip lag too large')
        selected = None
        for row in rows[1:]:
            archived = index.block(row['slot'])
            if archived:
                require(archived['hash'] == row['hash'] and archived['poh_timestamp'] == row.get('poh_timestamp'),
                        'native completed anchor mismatch')
                if selected is None:
                    selected = row
        require(selected is not None, 'no live completed overlap')
        timestamp = selected.get('poh_timestamp')
        require(type(timestamp) is int and 0 <= self.now() - timestamp / 1000 <= MAX_ANCHOR_AGE,
                'native completed anchor stale or future dated')
        return selected

    def refresh(self):
        with self.lock:
            try:
                result = self._refresh()
            except BaseException:
                with self.state_lock:
                    self.failed = True
                    self.epoch += 1
                raise
            with self.state_lock:
                self.failed = False
                self.epoch += 1
            return result

    def receipt_updates(self, index, deadline):
        """Optional bounded outcome enrichment, including older unknown rows.

        Caller holds the derived writer transaction and rechecks canonical source
        bytes after these reads. No unverified RPC effect/address is imported.
        Missing or malformed optional receipts do not invalidate valid blocks.
        """
        if self.fetch_receipt is None:
            return [], None
        deadline = min(deadline, time.monotonic() + RECEIPT_SECONDS)
        cursor = parse(index.meta('cloud_receipt_cursor') or 'null')
        require(cursor is None or type(cursor) is list and len(cursor) == 3
                and type(cursor[0]) is int and type(cursor[1]) is int and type(cursor[2]) is str,
                'invalid stored receipt cursor')
        conditions = "json_extract(data,'$.status')='unknown'"
        params = []
        if cursor:
            conditions += ' AND (slot,position,signature)<(?,?,?)'
            params.extend(cursor)
        # A query budget prevents scanning an arbitrarily large known-history
        # table from delaying canonical publication. No per-request scan occurs.
        steps = 0
        def progress():
            nonlocal steps
            steps += 1000
            return int(steps > 500_000 or time.monotonic() >= deadline)
        index.db.set_progress_handler(progress, 1000)
        try:
            rows = index.db.execute('SELECT signature,slot,position FROM transactions WHERE ' + conditions
                + ' ORDER BY slot DESC,position DESC,signature DESC LIMIT ?', (*params, RECEIPT_BATCH)).fetchall()
        except sqlite3.OperationalError as error:
            if getattr(error, 'sqlite_errorcode', None) != sqlite3.SQLITE_INTERRUPT:
                raise
            return [], {'checked': 0, 'imported': 0, 'unavailable_or_invalid': 0, 'rejected': 0,
                        'cursor': cursor, 'query_budget_exhausted': True,
                        'observed_at_ms': int(self.now() * 1000)}
        finally:
            index.db.set_progress_handler(None, 0)
        updates, checked, rejected, last = [], 0, 0, None
        for row in rows:
            if time.monotonic() >= deadline:
                break
            last = [row['slot'], row['position'], row['signature']]
            checked += 1
            try:
                value = self.fetch_receipt(row['signature'], row['slot'], deadline=deadline)
                require(time.monotonic() < deadline, 'receipt batch deadline exceeded')
                tx, block = index.transaction(row['signature']), index.block(row['slot'])
                require(type(value) is dict and set(value) == {'receipt', 'block'}, 'invalid receipt response')
                receipt, observed = value['receipt'], value['block']
                if receipt is None:
                    continue
                require(type(receipt) is dict and type(receipt.get('slot')) is int and receipt['slot'] == tx['slot']
                        and type(receipt.get('transaction')) is dict and receipt['transaction'].get('signatures') == tx['signatures'],
                        'receipt transaction identity mismatch')
                meta = receipt.get('meta')
                require(type(meta) is dict, 'missing execution evidence')
                outcomes = meta.get('instructionOutcomes')
                require(type(outcomes) is list and len(outcomes) == len(tx['instructions']) and len(outcomes) > 0
                        and all(type(item) is dict and set(item) == {'index', 'ok'} and type(item['index']) is int
                                and item['index'] == position and type(item['ok']) is bool for position, item in enumerate(outcomes)),
                        'incomplete execution outcomes')
                first_failed = next((item['index'] for item in outcomes if not item['ok']), None)
                expected = None if first_failed is None else {'InstructionError': [first_failed, 'ExecutionFailed']}
                require('err' in meta and h.canonical(meta['err']) == h.canonical(expected), 'outcome error mismatch')
                require(type(observed) is dict and observed.get('success') is True and type(observed.get('data')) is dict,
                        'native canonical block unavailable')
                header = observed['data']
                require(type(header.get('slot')) is int and header['slot'] == block['slot']
                        and tx['block_hash'] == header.get('hash') == block['hash']
                        and header.get('merkle_root') == block['merkle_root'], 'receipt canonical block mismatch')
                members = header.get('transactions')
                require(type(members) is list and type(header.get('transaction_count')) is int
                        and header['transaction_count'] == len(members) == block['transaction_count']
                        and all(type(member) is dict for member in members)
                        and [member.get('signature') for member in members] == block['transactions']
                        and members[tx['position']]['signature'] == tx['signature'], 'receipt canonical membership mismatch')
                # Preserve complete outcomes, not unvalidated summary transfers
                # or address attribution. Exact effects remain decoded from wire.
                updates.append((tx['signature'], {'slot': tx['slot'], 'transaction': {'signatures': tx['signatures']},
                    'meta': {'instructionOutcomes': outcomes, 'err': expected},
                    'canonical_block': {'slot': block['slot'], 'hash': block['hash']}}))
            except (ValueError, KeyError, IndexError, TypeError, OSError, subprocess.SubprocessError):
                rejected += 1
        next_cursor = last if last is not None and (len(rows) == RECEIPT_BATCH or checked < len(rows)) else None
        return updates, {'checked': checked, 'imported': len(updates), 'unavailable_or_invalid': checked - len(updates),
                         'rejected': rejected, 'cursor': next_cursor, 'observed_at_ms': int(self.now() * 1000)}

    def _refresh(self):
        """One bounded transactional derived-index refresh; no L1 writes."""
        with self.lock:
            self.initialize()
            index = h.Index(self.index_path)
            try:
                anchor = parse(index.meta('cloud_anchor'))
                deadline = time.monotonic() + OPERATION_SECONDS
                with opened_public(self.path, MAX_FILE) as stream:
                    start = os.fstat(stream.fileno())
                    require(anchor['bytes'] <= start.st_size, 'stable prefix truncated')
                    digest = self.hash_prefix(stream, anchor['bytes'], deadline)
                    require(digest.hexdigest() == anchor['sha256'], 'deep source divergence; explicit rebuild required')
                    stream.seek(anchor['bytes'])
                    records, boundaries = [], deque(maxlen=STABLE_RECORDS + 1)
                    last_slot, last_hash, end = anchor['slot'], anchor['hash'], anchor['bytes']
                    consumed, total = 0, anchor['records']
                    while stream.tell() < start.st_size:
                        require(time.monotonic() < deadline, 'suffix verification timed out')
                        raw = stream.readline(min(MAX_LINE + 1, start.st_size - stream.tell()))
                        require(len(raw) <= MAX_LINE, 'oversized public block')
                        if not raw.endswith(b'\n'):
                            break
                        consumed += len(raw)
                        require(consumed <= MAX_SUFFIX_BYTES and len(records) < MAX_SUFFIX_RECORDS,
                                'suffix exceeds bounded refresh; operator catchup required')
                        block = parse(raw)
                        normalized, txs = h.normalize_block(block, [encode(tx) for tx in block['transactions']], 'cloud-ledger')
                        require(normalized['slot'] > last_slot and normalized['previous_hash'] == last_hash,
                                'suffix parent/order mismatch')
                        envelope = octets(block['proposer_sig'])
                        require(envelope[:8] in (b'XRSRV3\0\0', b'XRSGAP3\0') and envelope[8:40].hex() == ROSTER_HASH,
                                'wrong recovery roster commitment')
                        require(work_hash(block) == normalized['hash'], 'v4 header commitment mismatch')
                        records.append((normalized, txs))
                        digest.update(raw)
                        last_slot, last_hash, end = normalized['slot'], normalized['hash'], stream.tell()
                        total += 1
                        boundaries.append({'slot': last_slot, 'hash': last_hash, 'bytes': end,
                                           'sha256': digest.hexdigest(), 'records': total})
                    require(records, 'no canonical suffix after stable anchor')
                    require(self.hash_prefix(stream, end, deadline).hexdigest() == digest.hexdigest(),
                            'source prefix changed during verification')
                    self.source_matches(stream, identity(start), end)
                    with h.atomic(index.db):
                        common, change = anchor, None
                        for position, (block, _txs) in enumerate(records):
                            old = index.block(block['slot'])
                            if old and old['hash'] == block['hash']:
                                common = {'slot': block['slot'], 'hash': block['hash']}
                            elif old or index.db.execute('SELECT 1 FROM blocks WHERE slot>=? LIMIT 1', (block['slot'],)).fetchone():
                                change = position
                                break
                            else:
                                break
                        if change is not None:
                            index.replace_suffix(common['slot'], common['hash'], records[change:])
                        else:
                            for block, txs in records:
                                index._put(block, txs)
                            require(index.db.execute('SELECT max(slot) FROM blocks').fetchone()[0] == last_slot,
                                    'source is a shorter prefix; explicit rebuild required')
                        live = self.match_live(index)
                        receipt_updates, receipt_refresh = self.receipt_updates(index, deadline)
                        # The native request is outside our trust boundary too:
                        # recheck after it, so a source rewrite during that call
                        # cannot activate the prior digest as current evidence.
                        require(self.hash_prefix(stream, end, deadline).hexdigest() == digest.hexdigest(),
                                'source prefix changed during native verification')
                        self.source_matches(stream, identity(start), end)
                        self.metadata()
                        for signature, receipt in receipt_updates:
                            index._receipt(signature, receipt, 'same-node-rpc-canonical-block')
                        if receipt_refresh is not None:
                            index.setmeta('cloud_receipt_cursor', h.canonical(receipt_refresh['cursor']))
                            index.setmeta('cloud_receipt_refresh', h.canonical(receipt_refresh))
                        verified = self.now()
                        next_anchor = boundaries[0] if len(boundaries) > STABLE_RECORDS else anchor
                        generation = {'tip': {'slot': last_slot, 'hash': last_hash},
                                      'verified_at_ms': int(verified * 1000),
                                      'anchor_slot': live['slot'], 'anchor_hash': live['hash'],
                                      'source_identity': list(identity(start)), 'source_bytes': end}
                        generation['id'] = hashlib.sha256(h.canonical(generation).encode()).hexdigest()
                        index.setmeta('cloud_anchor', h.canonical(next_anchor))
                        index.setmeta('cloud_generation', h.canonical(generation))
                        index.setmeta('ledger_prefix', h.canonical({'bytes': end, 'sha256': digest.hexdigest(),
                            'records': total, 'header_commitments_recomputed': total,
                            'prefix_rehashed': True, 'observer_matches': 0}))
                        # Compute chain-wide coverage once per background refresh,
                        # not once per public HTTP request.
                        coverage = index.coverage()
                        if receipt_refresh is not None:
                            coverage['receipt_refresh'] = receipt_refresh
                        index.setmeta('cloud_coverage', h.canonical(coverage))
                    return generation
            finally:
                index.close()

    def checkpoint(self):
        # A healthy background publication can supersede a native read. Retry
        # once with a fresh SQLite snapshot; repeated publication only fails
        # this request and does not invalidate the latest verified generation.
        for attempt in range(2):
            try:
                return self._checkpoint()
            except GenerationChanged:
                if attempt == 1:
                    raise

    def _checkpoint(self):
        # Queries use their own coherent read snapshot while the writer verifies
        # the next generation. No HTTP request waits on a ledger scan.
        with self.state_lock:
            require(not self.failed, 'archive refresh unavailable')
            epoch = self.epoch
        index = self.read_index()
        try:
            generation = parse(index.meta('cloud_generation') or 'null')
            require(generation and 0 <= self.now() * 1000 - generation['verified_at_ms'] <= MAX_ANCHOR_AGE * 1000,
                    'archive generation stale')
            self.metadata()
            checkpoint = parse(index.meta('cloud_checkpoint'))
            with opened_public(self.path, MAX_FILE) as stream:
                self.source_matches(stream, tuple(generation['source_identity']), generation['source_bytes'])
                stream.seek(checkpoint['offset'])
                require(hashlib.sha256(stream.read(checkpoint['length'])).hexdigest() == checkpoint['sha256'],
                        'checkpoint source changed')
                live = self.match_live(index)
                self.source_matches(stream, tuple(generation['source_identity']), generation['source_bytes'])
            now = self.now()
            with self.state_lock:
                require(not self.failed, 'archive refresh unavailable')
                if self.epoch != epoch:
                    raise GenerationChanged('archive generation changed during native verification')
                require(0 <= now * 1000 - generation['verified_at_ms'] <= MAX_ANCHOR_AGE * 1000,
                        'archive generation stale')
                return {'success': True, 'data': checkpoint['data'], 'attestation': {
                    'chain_id': h.CHAIN, 'generation': generation['id'], 'anchor_slot': live['slot'],
                    'anchor_hash': live['hash'], 'observed_at_ms': int(now * 1000),
                    'prefix_verified_at_ms': generation['verified_at_ms']}}
        except GenerationChanged:
            raise
        except BaseException as error:
            with self.state_lock:
                # A new canonical generation can legitimately disagree with an
                # old read snapshot. It must pass every check on the retry.
                if isinstance(error, Exception) and not self.failed and self.epoch != epoch:
                    raise GenerationChanged('archive generation superseded failed read') from None
                self.failed = True
                self.epoch += 1
            raise
        finally:
            index.close()

    def historical(self, kind, identifier=None, limit=100, cursor=None):
        require(type(limit) is int and 1 <= limit <= 100 and
                (cursor is None or type(cursor) is str and len(cursor) <= 1024), 'invalid pagination')
        index = self.read_index()
        try:
            generation = parse(index.meta('cloud_generation') or 'null')
            coverage = parse(index.meta('cloud_coverage')) if index.meta('cloud_coverage') else index.coverage()
            coverage.update(list_page_size=100, block_shard_size=1000)
            coverage['verified_at_ms'] = generation['verified_at_ms'] if generation else None
            coverage['stale'] = self.failed or not generation or not 0 <= self.now() * 1000 - generation['verified_at_ms'] <= MAX_ANCHOR_AGE * 1000
            result = {'generation': generation['id'] if generation else None, 'coverage': coverage}
            if kind == 'coverage':
                result['data'] = coverage
            elif kind == 'accounts':
                result.update(self.accounts(index, coverage, limit, cursor))
            elif kind in ('block', 'transaction'):
                result['data'] = index.block(identifier) if kind == 'block' else index.transaction(identifier)
            elif kind in ('blocks', 'transactions', 'address'):
                self.validate_cursor(index, 'transactions' if kind == 'address' else kind,
                                     identifier if kind == 'address' else None, cursor)
                result.update(index._page('transactions' if kind == 'address' else kind, limit, cursor,
                                          identifier if kind == 'address' else None, coverage))
                result['coverage'] = coverage
            elif kind == 'search':
                require(type(identifier) is str and re.fullmatch(r'(?:[1-9][0-9]{0,15}|[a-f0-9]{64}|[1-9A-HJ-NP-Za-km-z]{32,88})', identifier),
                        'invalid search identifier')
                block = index.block(identifier)
                transaction = index.transaction(identifier) if block is None else None
                if block is not None:
                    result.update(type='block', data=block)
                elif transaction is not None:
                    result.update(type='transaction', data=transaction)
                elif index.db.execute('SELECT 1 FROM addresses WHERE address=? LIMIT 1', (identifier,)).fetchone():
                    page = index._page('transactions', limit, None, identifier, coverage)
                    result.update(type='address', data={'address': identifier, 'transactions': page['data'],
                                  'cursor': page['cursor'], 'page': 1, 'page_size': limit,
                                  'snapshot_tip': page['snapshot_tip']})
                else:
                    result.update(type='not_found', data=None)
            else:
                raise ValueError('unsupported history query')
            return result
        finally:
            index.close()

    def accounts(self, index, coverage, limit, cursor):
        """Earliest indexed activity, never inferred wallet creation or balance.

        Query-only on the existing coherent SQLite snapshot. A deterministic VM
        budget and wall deadline protect the node host from growing scan cost.
        No public request opens the ledger or materializes an unbounded list.
        """
        self.validate_cursor(index, 'accounts', None, cursor)
        tip, before = coverage['tip'], None
        if cursor:
            value = parse(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
            tip = {'slot': value['tip_slot'], 'hash': value['tip_hash']}
            before = value['before']
        common = {'basis': 'earliest_indexed_activity', 'snapshot_tip': tip}
        if not tip:
            return {**common, 'data': [], 'cursor': None, 'truncated': False}
        deadline, steps = time.monotonic() + ACCOUNT_QUERY_SECONDS, 0
        def progress():
            nonlocal steps
            steps += 1000
            return int(steps > ACCOUNT_QUERY_VM_STEPS or time.monotonic() >= deadline)
        index.db.set_progress_handler(progress, 1000)
        try:
            rows = index.db.execute('''WITH appearances AS (
                SELECT a.address,t.slot FROM addresses a JOIN transactions t USING(signature) WHERE t.slot<=?
                UNION ALL SELECT json_extract(data,'$.proposer'),slot FROM blocks WHERE slot<=?
              ), first_seen AS (
                SELECT address,min(slot) AS first_seen_slot FROM appearances
                WHERE address IS NOT NULL AND address!=? GROUP BY address
              ) SELECT f.address,f.first_seen_slot,json_extract(b.data,'$.poh_timestamp') AS stamp
                FROM first_seen f JOIN blocks b ON b.slot=f.first_seen_slot
                WHERE (? IS NULL OR f.first_seen_slot>? OR (f.first_seen_slot=? AND f.address>?))
                ORDER BY f.first_seen_slot,f.address LIMIT ?''',
                (tip['slot'], tip['slot'], '1' * 32,
                 before[0] if before else None, before[0] if before else None,
                 before[0] if before else None, before[1] if before else None, limit + 1)).fetchall()
        finally:
            index.db.set_progress_handler(None, 0)
        require(time.monotonic() < deadline, 'account query exceeded time bound')
        more, data = len(rows) > limit, []
        for row in rows[:limit]:
            require(type(row['address']) is str and ACCOUNT.fullmatch(row['address'])
                    and type(row['first_seen_slot']) is int and 0 < row['first_seen_slot'] <= tip['slot'],
                    'invalid indexed account appearance')
            stamp = row['stamp']
            data.append({'address': row['address'], 'first_seen_slot': row['first_seen_slot'],
                         'first_seen_timestamp_ms': stamp if type(stamp) is int and 0 < stamp < 2**53 else None})
        next_cursor = None
        if more:
            last = data[-1]
            value = {'kind': 'accounts', 'address': None, 'revision': int(index.meta('revision') or 0),
                     'tip_slot': tip['slot'], 'tip_hash': tip['hash'],
                     'before': [last['first_seen_slot'], last['address']]}
            next_cursor = base64.urlsafe_b64encode(h.canonical(value).encode()).decode().rstrip('=')
        return {**common, 'data': data, 'cursor': next_cursor, 'truncated': more}

    def dispatch(self, target, method='GET'):
        """Pure request routing, injectable in tests without binding a socket."""
        if method != 'GET':
            return 405, {'error': 'Only GET is supported'}
        try:
            require(type(target) is str and len(target) <= 2048 and '%' not in target.split('?')[0], 'invalid path')
            url = urlsplit(target)
            require(not url.scheme and not url.netloc and not url.fragment, 'absolute request target rejected')
            params = parse_qs(url.query, keep_blank_values=True)
            allowed = {'q'} if url.path == '/history/search' else {'cursor'}
            require(all(k in allowed and len(v) == 1 and len(v[0]) <= 1024 for k, v in params.items()), 'invalid query')
            if url.path == f'/v2/block/slot/{h.CHECKPOINT_SLOT}' and not params:
                return 200, self.checkpoint()
            if url.path == '/health' and not params:
                coverage = self.historical('coverage')['coverage']
                ready = not coverage['stale']
                return (200 if ready else 503), {'ready': ready, 'verified_at_ms': coverage['verified_at_ms']}
            if url.path == '/history/search':
                require(set(params) == {'q'}, 'search query required')
                result = self.historical('search', params['q'][0])
                return (404 if result.get('data') is None else 200), result
            match = re.fullmatch(r'/history/(coverage|blocks|transactions|block|transaction|address|accounts)(?:/([A-Za-z0-9_-]{1,128}))?', url.path)
            if not match:
                return 404, {'error': 'Unknown history endpoint'}
            kind, identifier = match.groups()
            require((identifier is not None) == (kind in ('block', 'transaction', 'address')), 'invalid identifier')
            require(not params or kind in ('blocks', 'transactions', 'address', 'accounts'), 'cursor not supported')
            result = self.historical(kind, identifier, cursor=params.get('cursor', [None])[0])
            return (404 if result.get('data') is None else 200), result
        except CursorError as error:
            return error.status, {'error': {'code': 'cursor_expired' if error.status == 410 else 'invalid_cursor',
                                          'message': str(error)}}
        except Exception:
            return 503, {'error': 'Archive request unavailable'}


def serve(archive):
    def worker():
        while True:
            try:
                archive.refresh()
            except Exception:
                print('Archive refresh unavailable; existing history retained as stale.', flush=True)
            time.sleep(REFRESH_SECONDS)
    threading.Thread(target=worker, daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.reply(*archive.dispatch(self.path))

        def do_POST(self):
            self.reply(*archive.dispatch(self.path, 'POST'))

        def reply(self, status, value):
            raw = h.canonical(value).encode()
            if len(raw) > MAX_RESPONSE:
                status, raw = 503, b'{"error":"Response exceeds public bound"}'
            self.send_response(status)
            for key, val in {'Content-Type': 'application/json', 'Content-Length': str(len(raw)),
                             'Cache-Control': 'no-store', 'X-Xeris-Network': 'mainnet',
                             'X-Xeris-Chain-Id': h.CHAIN, 'Connection': 'close'}.items():
                self.send_header(key, val)
            self.end_headers()
            self.wfile.write(raw)
            self.close_connection = True

    server = HTTPServer(('127.0.0.1', 56003), Handler)
    server.serve_forever(poll_interval=0.5)


if __name__ == '__main__':
    if sys.argv[1:] == ['--read-receipt']:
        try:
            raw = sys.stdin.buffer.read(1025)
            require(0 < len(raw) <= 1024, 'receipt request exceeds bound')
            request = parse(raw)
            require(type(request) is dict and set(request) == {'signature', 'slot'}, 'invalid receipt request')
            result = json.dumps(_receipt_http(request['signature'], request['slot']), separators=(',', ':'), allow_nan=False).encode()
            require(len(result) <= RECEIPT_RESPONSE * 2 + 128, 'receipt response exceeds bound')
            sys.stdout.buffer.write(result)
        except Exception:
            raise SystemExit(1)
        raise SystemExit(0)
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', required=True)
    parser.add_argument('--ledger', default='/var/lib/xeris/mainnet-v4/ledger.dat')
    parser.add_argument('--roster', default='/etc/xeris/genesis-roster.json')
    parser.add_argument('--ruleset', default='/var/lib/xeris/mainnet-v4/.xeris-mainnet-ruleset')
    options = parser.parse_args()
    serve(CloudArchive(options.index, options.ledger, options.roster, options.ruleset, fetch_receipt=fetch_receipt))
