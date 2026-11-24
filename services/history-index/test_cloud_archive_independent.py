"""Independent adversarial checks. Temporary public fixtures only; no network/node IO."""
import base64
from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

import cloud_archive as cloud
import history_index as history
from wire import b58, decode, encode, merkle, short, work_hash


def transaction(seed):
    vec = lambda values: [list(short(len(values))), *values]
    sender, recipient = b58(bytes([seed]) * 32), b58(bytes([seed + 1]) * 32)
    string = lambda value: struct.pack('<Q', len(value)) + value.encode()
    data = struct.pack('<I', 11) + string(sender) + string(recipient) + struct.pack('<Q', 2**53 + 7)
    return {'signatures': vec([list(bytes([seed]) * 64)]), 'message': {
        'header': {'num_required_signatures': 1, 'num_readonly_signed_accounts': 0,
                   'num_readonly_unsigned_accounts': 0},
        'account_keys': vec([list(bytes([seed]) * 32)]), 'recent_blockhash': [0] * 32,
        'instructions': vec([{'program_id_index': 0, 'accounts': vec([]),
                              'data': vec(list(data))}])}}


def blocks(slots, parent=None, branch=1, transaction_slot=None):
    result = []
    previous = [] if parent is None else parent
    for slot in slots:
        txs = [transaction(branch + 1)] if slot == transaction_slot else []
        wires = [base64.b64decode(encode(tx), validate=True) for tx in txs]
        record = {'slot': slot, 'nonce': branch, 'poh_timestamp': (1960 + slot) * 1000,
                  'proposer': [1] * 32, 'previous_hash': previous,
                  'poh_hash': [branch] * 32, 'proposer_sig': list(b'XRSRV3\0\0' + bytes.fromhex('a' * 64) + b'\0'),
                  'merkle_root': list(bytes.fromhex(merkle(wires))), 'transactions': txs}
        record['hash'] = list(bytes.fromhex(work_hash(record)))
        result.append(record)
        previous = record['hash']
    return result


def serialized(records):
    return b''.join(json.dumps(record, separators=(',', ':')).encode() + b'\n' for record in records)


class IndependentCloudArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ledger, self.roster, self.ruleset = (self.root / name for name in ('ledger.dat', 'roster.json', 'ruleset'))
        self.index_path = self.root / 'history.sqlite3'
        self.records = blocks(range(1, 9), transaction_slot=7)
        self.ledger.write_bytes(serialized(self.records))
        self.roster.write_bytes(b'{"test":"public roster fixture"}\n')
        self.ruleset.write_text('xeris-mainnet-v4\n')
        self.clock = 2000.0
        self.live_override = None
        self.live_calls = 0
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        pin = bytes(self.records[1]['hash']).hex()
        values = {'CHECKPOINT_SLOT': 2, 'CHECKPOINT_HASH': pin,
                  'ROSTER_HASH': 'a' * 64, 'ROSTER_FILE_SHA256': hashlib.sha256(self.roster.read_bytes()).hexdigest(),
                  'STABLE_RECORDS': 3}
        # The public constants may be referenced through the reused modules.
        modules = [cloud, history]
        if hasattr(cloud, 'checkpoint'):
            modules.append(cloud.checkpoint)
        for module in modules:
            for key, value in values.items():
                if hasattr(module, key):
                    self.stack.enter_context(patch.object(module, key, value))
        observer = history.Index(self.root / 'observer.sqlite3')
        observer.put(*history.normalize_block(self.records[1], [], 'synthetic-observer'))
        baseline = history.backfill_ledger(observer, self.ledger, self.index_path)
        baseline.close()
        observer.close()
        self.service = cloud.CloudArchive(self.index_path, self.ledger, self.roster, self.ruleset,
                                         fetch_live=self.fetch, clock=lambda: self.clock)
        self.addCleanup(self.close_service)

    def close_service(self):
        if hasattr(self.service, 'close'):
            self.service.close()
        elif hasattr(self.service, 'index'):
            self.service.index.close()

    def fetch(self):
        self.live_calls += 1
        if callable(self.live_override):
            return self.live_override()
        if self.live_override is not None:
            return copy.deepcopy(self.live_override)
        return {'success': True, 'data': [
            {'slot': b['slot'], 'hash': bytes(b['hash']).hex(), 'poh_timestamp': b['poh_timestamp']}
            for b in reversed(self.records[-20:])]}

    def start(self):
        self.service.initialize()
        self.service.refresh()
        return self.service.checkpoint()

    def index_tip(self):
        db = history.readonly(self.index_path)
        try:
            return tuple(db.execute('SELECT slot,hash FROM blocks ORDER BY slot DESC LIMIT 1').fetchone())
        finally:
            db.close()

    def test_original_checkpoint_works_without_native_old_slot_lookup(self):
        before = self.ledger.read_bytes()
        result = self.start()
        self.assertIs(result['success'], True)
        self.assertEqual(result['data']['slot'], 2)
        self.assertEqual(result['data']['hash'], bytes(self.records[1]['hash']).hex())
        self.assertGreater(self.live_calls, 0)
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_append_persists_history_and_preserves_exact_transaction_wire(self):
        self.start()
        self.records.extend(blocks(range(9, 11), self.records[-1]['hash'], branch=2, transaction_slot=10))
        self.ledger.write_bytes(serialized(self.records))
        self.service.refresh()
        self.assertEqual(self.index_tip()[0], 10)
        tx, _ = decode(encode(self.records[-1]['transactions'][0]))
        result = self.service.historical('transaction', tx['signature'])
        self.assertEqual(result['data']['wire_base64'], tx['wire_base64'])
        self.assertEqual(result['data']['instructions'][0]['decoded']['amount_raw'], str(2**53 + 7))
        self.assertEqual(result['data']['status'], 'unknown')

    def test_live_hash_mismatch_invalidates_gate_but_keeps_previous_history(self):
        self.start()
        previous = self.index_tip()
        live = self.fetch()
        live['data'][1]['hash'] = 'f' * 64
        self.live_override = live
        with self.assertRaises(ValueError):
            self.service.refresh()
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertEqual(self.index_tip(), previous)
        self.assertEqual(self.service.historical('block', '2')['data']['hash'], bytes(self.records[1]['hash']).hex())

    def test_stale_or_future_live_evidence_never_reuses_previous_success(self):
        self.start()
        for now in (2300.0, 1900.0):
            with self.subTest(now=now):
                self.clock = now
                with self.assertRaises(ValueError):
                    self.service.checkpoint()

    def test_native_false_success_cannot_establish_identity(self):
        self.start()
        self.live_override = {'success': False, 'error': 'native data unavailable'}
        with self.assertRaises(ValueError):
            self.service.refresh()
        with self.assertRaises(ValueError):
            self.service.checkpoint()

    def advance_native_before_archive_refresh(self):
        self.start()
        appended = blocks(range(9, 45), self.records[-1]['hash'])
        with self.ledger.open('ab') as stream:
            stream.write(serialized(appended))
        self.records.extend(appended)
        self.clock = 2048.0
        self.live_override = {'success': True, 'data': [
            {'slot': block['slot'], 'hash': bytes(block['hash']).hex(),
             'poh_timestamp': block['poh_timestamp']}
            for block in reversed(self.records[-100:])]}

    def test_native_36_slot_advance_at_48_seconds_retains_fresh_completed_overlap(self):
        self.advance_native_before_archive_refresh()
        self.assertEqual(self.index_tip()[0], 8)
        self.assertEqual(self.live_override['data'][0]['slot'], 44)
        self.assertGreater(len(self.live_override['data']), 20)
        result = self.service.checkpoint()
        self.assertTrue(result['success'])
        self.assertEqual(result['attestation']['anchor_slot'], 8)
        self.assertEqual(result['attestation']['anchor_hash'], bytes(self.records[7]['hash']).hex())
        self.assertEqual(result['attestation']['prefix_verified_at_ms'], 2_000_000)
        self.assertEqual(self.index_tip()[0], 8)

    def test_wider_native_window_still_rejects_wrong_completed_overlap_hash(self):
        self.advance_native_before_archive_refresh()
        next(row for row in self.live_override['data'] if row['slot'] == 8)['hash'] = 'f' * 64
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertTrue(self.service.failed)

    def test_wider_native_window_still_rejects_overlap_older_than_120_seconds(self):
        self.advance_native_before_archive_refresh()
        self.clock = 2089.0  # Generation age89s; newest retained overlap age121s.
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertTrue(self.service.failed)

    def test_wider_native_window_keeps_feed_size_tip_lag_and_overlap_bounds(self):
        self.advance_native_before_archive_refresh()
        native = copy.deepcopy(self.live_override)
        variants = []
        too_many = [{'slot': slot, 'hash': 'e' * 64, 'poh_timestamp': 2_048_000}
                    for slot in range(108, 7, -1)]
        variants.append({'success': True, 'data': too_many})
        lagged = copy.deepcopy(native)
        lagged['data'][0]['slot'] = 109
        variants.append(lagged)
        variants.append({'success': True, 'data': native['data'][:36]})
        for value in variants:
            with self.subTest(rows=len(value['data']), tip=value['data'][0]['slot']):
                self.live_override = value
                index = self.service.read_index()
                try:
                    with self.assertRaises(ValueError):
                        self.service.match_live(index)
                finally:
                    index.close()

    def test_shallow_reorg_removes_orphan_transaction_and_invalidates_cursor(self):
        self.start()
        first = self.service.historical('blocks', limit=2)
        old_tx, _ = decode(encode(self.records[6]['transactions'][0]))
        self.records = self.records[:5] + blocks(range(6, 10), self.records[4]['hash'], branch=9, transaction_slot=8)
        replacement = self.root / 'replacement-ledger.dat'
        replacement.write_bytes(serialized(self.records))
        os.replace(replacement, self.ledger)
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.service.refresh()
        self.assertEqual(self.index_tip()[0], 9)
        db = history.readonly(self.index_path)
        try:
            self.assertIsNone(db.execute('SELECT signature FROM transactions WHERE signature=?', (old_tx['signature'],)).fetchone())
            self.assertGreater(int(db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0]), 0)
        finally:
            db.close()
        with self.assertRaises(ValueError):
            self.service.historical('blocks', limit=2, cursor=first['cursor'])
        status, result = self.service.dispatch('/history/blocks?cursor=' + first['cursor'])
        self.assertEqual(status, 410)
        self.assertIn('error', result)

    def test_dispatch_malformed_and_mismatched_cursors_are_bad_requests(self):
        self.start()
        first = self.service.historical('blocks', limit=2)
        encoded = first['cursor']
        decoded = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        encode_cursor = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
        invalid = ['bad', encoded + '=', encode_cursor([]),
                   encode_cursor({**decoded, 'before': True}),
                   encode_cursor({**decoded, 'kind': 'transactions'}),
                   encode_cursor({**decoded, 'tip_slot': True}),
                   encode_cursor({**decoded, 'extra': 'unexpected'})]
        for cursor in invalid:
            with self.subTest(cursor=cursor):
                self.assertEqual(self.service.dispatch('/history/blocks?cursor=' + cursor)[0], 400)
        self.assertEqual(self.service.dispatch('/history/transactions?cursor=' + encoded)[0], 400)
        self.assertEqual(self.service.dispatch('/history/blocks?cursor=' + encoded)[0], 200)

    def test_dispatch_changed_or_missing_cursor_anchor_expires_without_hiding_outage(self):
        self.start()
        encoded = self.service.historical('blocks', limit=2)['cursor']
        decoded = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
        for changes in ({'tip_hash': 'f' * 64}, {'tip_slot': 999}, {'revision': decoded['revision'] + 1}):
            cursor = base64.urlsafe_b64encode(json.dumps({**decoded, **changes}).encode()).decode().rstrip('=')
            self.assertEqual(self.service.dispatch('/history/blocks?cursor=' + cursor)[0], 410)
        with patch.object(self.service, 'read_index', side_effect=OSError('offline fixture')):
            self.assertEqual(self.service.dispatch('/history/blocks?cursor=' + encoded)[0], 503)

    def test_divergence_before_stable_anchor_rejects_without_rewriting_history(self):
        self.start()
        previous = self.index_tip()
        self.records = self.records[:2] + blocks(range(3, 10), self.records[1]['hash'], branch=9)
        self.ledger.write_bytes(serialized(self.records))
        with self.assertRaises(ValueError):
            self.service.refresh()
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertEqual(self.index_tip(), previous)

    def test_same_inode_prefix_rewrite_is_detected_even_when_mtime_is_restored(self):
        self.start()
        info = self.ledger.stat()
        mutated = copy.deepcopy(self.records)
        mutated[2]['nonce'] = 2
        raw = serialized(mutated)
        self.assertEqual(len(raw), info.st_size)
        self.ledger.write_bytes(raw)
        os.utime(self.ledger, ns=(info.st_atime_ns, info.st_mtime_ns))
        self.assertEqual(self.ledger.stat().st_ino, info.st_ino)
        with self.assertRaises(ValueError):
            self.service.refresh()
        with self.assertRaises(ValueError):
            self.service.checkpoint()

    def test_forged_suffix_parent_cannot_pass_using_unchanged_declared_hash(self):
        self.start()
        previous = self.index_tip()
        self.records[6]['previous_hash'] = [7] * 32
        self.ledger.write_bytes(serialized(self.records))
        with self.assertRaises(ValueError):
            self.service.refresh()
        self.assertEqual(self.index_tip(), previous)

    def test_missing_or_wrong_pin_cannot_initialize(self):
        self.records[1]['hash'] = [7] * 32
        self.ledger.write_bytes(serialized(self.records))
        with self.assertRaises(ValueError):
            self.service.initialize()

    def test_wrong_ruleset_or_roster_rejects_checkpoint(self):
        self.start()
        for path, value in ((self.ruleset, b'xeris-testnet-v2\n'), (self.roster, b'{}')):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(value)
                with self.assertRaises(ValueError):
                    self.service.checkpoint()
                path.write_bytes(original)

    def test_truncation_clears_gate_without_dropping_saved_history(self):
        self.start()
        previous = self.index_tip()
        self.ledger.write_bytes(serialized(self.records[:4]))
        with self.assertRaises(ValueError):
            self.service.refresh()
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertEqual(self.index_tip(), previous)

    def test_partial_append_never_enters_the_index(self):
        self.start()
        previous = self.index_tip()
        pending = blocks([9], self.records[-1]['hash'])[0]
        with self.ledger.open('ab') as stream:
            stream.write(serialized([pending])[:-20])
        self.service.refresh()
        self.assertEqual(self.index_tip(), previous)
        self.assertTrue(self.service.checkpoint()['success'])

    def test_completed_append_during_live_callback_waits_for_next_refresh(self):
        self.start()
        previous = self.index_tip()
        live = self.fetch()
        appended = False
        def append_once():
            nonlocal appended
            if not appended:
                with self.ledger.open('ab') as stream:
                    stream.write(serialized(blocks([9], self.records[-1]['hash'])))
                appended = True
            return live
        self.live_override = append_once
        self.service.refresh()
        self.assertEqual(self.index_tip(), previous)

    def test_source_rewrite_during_native_callback_cannot_publish(self):
        self.start()
        previous = self.index_tip()
        live = self.fetch()
        def rewrite():
            changed = copy.deepcopy(self.records)
            changed[2]['nonce'] = 2
            self.ledger.write_bytes(serialized(changed))
            return live
        self.live_override = rewrite
        with self.assertRaises(ValueError):
            self.service.refresh()
        self.assertEqual(self.index_tip(), previous)
        self.assertTrue(self.service.historical('coverage')['coverage']['stale'])

    def test_atomic_replacement_during_native_callback_cannot_publish(self):
        self.start()
        previous = self.index_tip()
        live = self.fetch()
        def replace():
            alternate = self.root / 'concurrent-ledger.dat'
            alternate.write_bytes(serialized(self.records))
            os.replace(alternate, self.ledger)
            return live
        self.live_override = replace
        with self.assertRaises(ValueError):
            self.service.refresh()
        self.assertEqual(self.index_tip(), previous)

    def test_checkpoint_does_not_ignore_a_failure_published_during_native_read(self):
        self.start()
        live = self.fetch()
        def publish_failure():
            self.service.failed = True
            return live
        self.live_override = publish_failure
        with self.assertRaises(ValueError):
            self.service.checkpoint()

    def test_checkpoint_retries_successful_background_publication_without_poisoning(self):
        before = self.start()['attestation']['generation']
        self.records.extend(blocks([9], self.records[-1]['hash']))
        with self.ledger.open('ab') as stream:
            stream.write(serialized(self.records[-1:]))
        self.clock += 1
        live, errors = self.fetch(), []
        def publish_success():
            self.live_override = None
            def refresh():
                try:
                    self.service.refresh()
                except BaseException as error:
                    errors.append(error)
            writer = threading.Thread(target=refresh)
            writer.start()
            writer.join(3)
            self.assertFalse(writer.is_alive(), 'publication waited for checkpoint reader')
            self.assertEqual(errors, [])
            return live
        self.live_override = publish_success
        result = self.service.checkpoint()
        self.assertTrue(result['success'])
        self.assertNotEqual(result['attestation']['generation'], before)
        self.assertEqual(result['attestation']['generation'], self.service.historical('coverage')['generation'])
        self.assertEqual(result['attestation']['prefix_verified_at_ms'], 2_001_000)
        self.assertFalse(self.service.failed)
        self.assertEqual(self.service.dispatch('/health')[0], 200)

    def test_two_healthy_publications_bound_retry_without_global_failure(self):
        self.start()
        publications = []
        def publish_again():
            self.live_override = None
            live = self.fetch()
            self.clock += 1
            publications.append(self.service.refresh())
            self.live_override = publish_again
            return live
        self.live_override = publish_again
        with self.assertRaises(cloud.GenerationChanged):
            self.service.checkpoint()
        self.assertEqual(len(publications), 2)
        self.assertFalse(self.service.failed)
        self.assertEqual(self.service.dispatch('/health')[0], 200)
        self.live_override = None
        self.assertTrue(self.service.checkpoint()['success'])

    def test_failed_refresh_during_checkpoint_still_invalidates_global_gate(self):
        self.start()
        live, invalid = self.fetch(), self.fetch()
        invalid['data'][1]['hash'] = 'f' * 64
        def publish_failure():
            self.live_override = invalid
            with self.assertRaises(ValueError):
                self.service.refresh()
            self.live_override = None
            return live
        self.live_override = publish_failure
        with self.assertRaises(ValueError):
            self.service.checkpoint()
        self.assertTrue(self.service.failed)
        self.assertEqual(self.service.dispatch('/health')[0], 503)

    def test_checkpoint_retries_old_snapshot_mismatch_after_valid_shallow_reorg(self):
        before = self.start()['attestation']['generation']
        def publish_reorg():
            self.live_override = None
            self.records = self.records[:5] + blocks(range(6, 10), self.records[4]['hash'], branch=9)
            self.ledger.write_bytes(serialized(self.records))
            self.clock += 1
            self.service.refresh()
            return self.fetch()
        self.live_override = publish_reorg
        result = self.service.checkpoint()
        self.assertTrue(result['success'])
        self.assertNotEqual(result['attestation']['generation'], before)
        self.assertEqual(result['attestation']['anchor_hash'], bytes(self.records[-2]['hash']).hex())
        self.assertEqual(self.index_tip()[0], 9)
        self.assertFalse(self.service.failed)

    def test_new_generation_retry_still_rejects_wrong_hash(self):
        self.start()
        invalid = self.fetch()
        invalid['data'][1]['hash'] = 'f' * 64
        def publish_then_return_wrong_hash():
            self.live_override = None
            self.clock += 1
            self.service.refresh()
            self.live_override = invalid
            return invalid
        self.live_override = publish_then_return_wrong_hash
        with self.assertRaises(ValueError) as caught:
            self.service.checkpoint()
        self.assertNotIsInstance(caught.exception, cloud.GenerationChanged)
        self.assertTrue(self.service.failed)
        self.assertEqual(self.service.dispatch('/health')[0], 503)

    def test_history_reader_does_not_wait_for_refresh_lock(self):
        self.start()
        entered, release, result = threading.Event(), threading.Event(), []
        def hold():
            with self.service.lock:
                entered.set()
                release.wait(3)
        holder = threading.Thread(target=hold)
        holder.start()
        self.assertTrue(entered.wait(1))
        def read():
            result.append(self.service.historical('block', '2'))
        reader = threading.Thread(target=read)
        try:
            reader.start()
            reader.join(1)
            self.assertFalse(reader.is_alive(), 'history waited for expensive verifier lock')
            self.assertEqual(result[0]['data']['slot'], 2)
        finally:
            release.set()
            holder.join(3)
            reader.join(3)

    def test_missing_verified_baseline_provenance_is_not_accepted(self):
        index = history.Index(self.index_path)
        with history.atomic(index.db):
            index.db.execute("DELETE FROM metadata WHERE key='ledger_prefix'")
        index.close()
        with self.assertRaises(ValueError):
            self.service.initialize()

    def test_cloud_history_matches_deployed_browser_coverage_contract(self):
        self.start()
        response = self.service.historical('coverage')
        self.assertRegex(response['generation'], r'^[0-9a-f]{64}$')
        self.assertEqual(response['coverage']['chain_id'], 'xeris-mainnet-v4')
        self.assertEqual(response['coverage']['list_page_size'], 100)
        self.assertEqual(response['coverage']['block_shard_size'], 1000)
        self.assertFalse(response['coverage']['stale'])
        self.assertEqual(response['coverage']['counts']['blocks'], 8)

    def test_history_observes_only_committed_generation_during_refresh(self):
        self.start()
        before = self.service.historical('coverage')
        self.records.extend(blocks([9, 10], self.records[-1]['hash'], branch=2))
        self.ledger.write_bytes(serialized(self.records))
        live = self.fetch()
        entered, release, errors = threading.Event(), threading.Event(), []
        def wait_during_native_read():
            entered.set()
            release.wait(3)
            return live
        self.live_override = wait_during_native_read
        def refresh():
            try:
                self.service.refresh()
            except BaseException as error:
                errors.append(error)
        writer = threading.Thread(target=refresh)
        try:
            writer.start()
            self.assertTrue(entered.wait(2), 'writer never reached pre-commit native check')
            current = self.service.historical('coverage')
            self.assertEqual(current['generation'], before['generation'])
            self.assertEqual(current['coverage']['tip']['slot'], 8)
            self.assertEqual(current['coverage']['counts']['blocks'], 8)
        finally:
            release.set()
            writer.join(4)
        self.assertFalse(writer.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.service.historical('coverage')['coverage']['tip']['slot'], 10)

    def test_old_pagination_snapshot_stays_stable_across_append(self):
        self.start()
        first = self.service.historical('blocks', limit=3)
        self.records.extend(blocks([9, 10], self.records[-1]['hash'], branch=2))
        self.ledger.write_bytes(serialized(self.records))
        self.service.refresh()
        second = self.service.historical('blocks', limit=3, cursor=first['cursor'])
        self.assertEqual([b['slot'] for b in first['data'] + second['data']], [8, 7, 6, 5, 4, 3])
        self.assertEqual(second['snapshot_tip']['slot'], 8)

    def test_bounds_reject_unsafe_query_and_nonfinite_clock(self):
        self.start()
        for kwargs in ({'limit': 101}, {'limit': True}, {'cursor': 'x' * 1025}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.service.historical('blocks', **kwargs)
        self.clock = float('nan')
        with self.assertRaises(ValueError):
            self.service.checkpoint()

    def test_dispatch_health_expires_and_never_claims_unverified_baseline_ready(self):
        self.service.initialize()
        self.assertEqual(self.service.dispatch('/health')[0], 503)
        self.service.refresh()
        self.assertEqual(self.service.dispatch('/health')[0], 200)
        self.clock += cloud.MAX_ANCHOR_AGE + 1
        self.assertEqual(self.service.dispatch('/health')[0], 503)

    def test_dispatch_routes_only_exact_checkpoint_and_rejects_mutation(self):
        self.start()
        calls = self.live_calls
        self.assertEqual(self.service.dispatch('/v2/block/slot/2', method='POST')[0], 405)
        self.assertEqual(self.service.dispatch('/v2/block/slot/3')[0], 404)
        self.assertEqual(self.service.dispatch('/submit')[0], 404)
        self.assertEqual(self.live_calls, calls)
        self.assertEqual(self.service.dispatch('/v2/block/slot/2')[0], 200)

    def test_dispatch_searches_slot_hash_transaction_and_address(self):
        self.start()
        tx, _ = decode(encode(self.records[6]['transactions'][0]))
        for query, kind in [('2', 'block'), (bytes(self.records[1]['hash']).hex(), 'block'),
                            (tx['signature'], 'transaction'), (tx['signer'], 'address')]:
            with self.subTest(kind=kind):
                status, result = self.service.dispatch('/history/search?q=' + query)
                self.assertEqual(status, 200)
                self.assertEqual(result['type'], kind)
                if kind == 'address':
                    self.assertEqual(result['data']['address'], tx['signer'])
                    self.assertEqual(result['data']['transactions'][0]['signature'], tx['signature'])
        status, result = self.service.dispatch('/history/transaction/' + b58(bytes([99]) * 64))
        self.assertEqual(status, 404)
        self.assertIsNone(result['data'])
        self.assertEqual(result['coverage']['indexed_from'], 1)


if __name__ == '__main__':
    unittest.main()
