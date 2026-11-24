"""Pure receipt fixtures: no source databases, network, signatures or funds."""
import base64
import copy
import sqlite3
import struct
import unittest
from receipt_effects import validate_effects
from wire import b58, short, decode


SIGNER = b58(bytes([1]) * 32)
RECIPIENT = b58(bytes([2]) * 32)
OTHER = b58(bytes([3]) * 32)
TIME = 2**80 + 17


def text(value):
    value = value.encode()
    return struct.pack('<Q', len(value)) + value


def integer(value): return struct.pack('<Q', value)
def instruction(variant, body=b''): return struct.pack('<I', variant) + body
def native(amount=19, recipient=RECIPIENT): return instruction(11, text(SIGNER) + text(recipient) + integer(amount))


def transaction(*instructions):
    wire = short(1) + bytes([1]) * 64 + bytes([1, 0, 0]) + short(1) + bytes([1]) * 32 + bytes(32) + short(len(instructions))
    for value in instructions: wire += b'\0' + short(0) + short(len(value)) + value
    tx, _ = decode(base64.b64encode(wire).decode())
    return {**tx, 'slot': 321}


def outcomes(*values): return [{'index': i, 'ok': value} for i, value in enumerate(values)]


def row(tx, kind='native_transfer', sender=SIGNER, recipient=RECIPIENT, amount=19, id=1):
    return {'id': id, 'slot': tx['slot'], 'signature': tx['signature'], 'tx_type': kind,
            'from_addr': sender, 'to_addr': recipient, 'amount': amount if amount < 2**63 else amount - 2**64,
            'timestamp': str(TIME)}


class ReceiptEffectsTests(unittest.TestCase):
    def test_known_node_receipt_arms(self):
        cases = [
            (native(), 'native_transfer', SIGNER, RECIPIENT, 19),
            (instruction(1, text('token') + text(SIGNER) + text(RECIPIENT) + integer(21)), 'token_transfer', SIGNER, RECIPIENT, 21),
            (instruction(0, text('token') + text(RECIPIENT) + integer(22)), 'token_mint', SIGNER, RECIPIENT, 22),
            (instruction(13, integer(23)), 'wrap_xrs', SIGNER, '', 23),
            (instruction(14, integer(24)), 'unwrap_xrs', SIGNER, '', 24),
            (instruction(4, text('pool-mainnet') + text('add_liquidity') + integer(2) + b'{}'), 'contract_call', SIGNER, 'pool-mainnet', 0),
            (instruction(5, text('pool-mainnet') + text('Swap') + text('{}')), 'other', SIGNER, '', 0),
            (instruction(2, text('token') + text(SIGNER) + integer(999)), 'other', SIGNER, '', 0),
            (instruction(9, text(SIGNER) + integer(25)), 'stake', SIGNER, '', 25),
            (instruction(10, text(SIGNER) + integer(26)), 'unstake', SIGNER, '', 26),
            (instruction(12, text(SIGNER) + integer(5) + integer(0)), 'attestation', SIGNER, '', 0),
            (instruction(48, text('token') + text(SIGNER) + text(RECIPIENT) + integer(0) * 4), 'zk_private_transfer', SIGNER, RECIPIENT, 0),
            (instruction(52, text(SIGNER) + text(RECIPIENT) + integer(27) + integer(0) + text('algorithm')), 'pq_transfer', SIGNER, RECIPIENT, 27),
        ]
        for data, kind, sender, recipient, amount in cases:
            with self.subTest(kind=kind, amount=amount):
                tx = transaction(data)
                result = validate_effects(tx, outcomes(True), [row(tx, kind, sender, recipient, amount)], TIME)
                self.assertEqual(result['validation']['matched_receipts'], 1)
                self.assertEqual(result['effects'][0]['amount_raw'], str(amount))
                self.assertEqual(result['effects'][0]['instruction_index'], 0)
                self.assertEqual(result['effects'][0]['timestamp'], str(TIME))
                self.assertNotIn('pool-mainnet', result['addresses'])

    def test_unsigned_amount_roundtrip_preserves_full_u64(self):
        for amount in (0, 2**63 - 1, 2**63, 2**64 - 1):
            tx = transaction(native(amount))
            record = row(tx, amount=amount)
            result = validate_effects(tx, outcomes(True), [record], str(TIME))
            self.assertEqual(result['effects'][0]['amount_raw'], str(amount))
            self.assertEqual(result['effects'][0]['sqlite_amount_signed'], str(record['amount']))
        record['amount'] = 2**64 - 1
        with self.assertRaisesRegex(ValueError, 'signed amount'):
            validate_effects(tx, outcomes(True), [record])

    def test_known_field_counterexamples_are_rejected(self):
        tx = transaction(native())
        for field, value in [('amount', 20), ('from_addr', OTHER), ('to_addr', OTHER), ('tx_type', 'other'),
                             ('slot', 322), ('signature', 'wrong'), ('timestamp', str(TIME + 1))]:
            with self.subTest(field=field):
                bad = row(tx); bad[field] = value
                with self.assertRaises(ValueError): validate_effects(tx, outcomes(True), [bad], TIME)
        with self.assertRaisesRegex(ValueError, 'count or wire fields'):
            validate_effects(tx, outcomes(True), [], TIME)

    def test_burn_does_not_claim_its_amount_as_a_transfer_receipt(self):
        tx = transaction(instruction(2, text('token') + text(SIGNER) + integer(999)))
        for kind, amount in [('token_burn', 999), ('other', 999), ('token_transfer', 999)]:
            with self.assertRaisesRegex(ValueError, 'count or wire fields'):
                validate_effects(tx, outcomes(True), [row(tx, kind, recipient='', amount=amount)])
        self.assertEqual(validate_effects(tx, outcomes(True), [row(tx, 'other', recipient='', amount=0)])['effects'][0]['amount_raw'], '0')

    def test_failed_instructions_have_no_receipts_and_partial_transactions_keep_positions(self):
        tx = transaction(native(), native(20), native(21))
        result = validate_effects(tx, outcomes(True, False, True), [row(tx), row(tx, amount=21, id=2)], TIME)
        self.assertEqual([effect['instruction_index'] for effect in result['effects']], [0, 2])
        with self.assertRaisesRegex(ValueError, 'count or wire fields'):
            validate_effects(tx, outcomes(True, False, True), [row(tx), row(tx, amount=20, id=2), row(tx, amount=21, id=3)])
        failed = transaction(native())
        self.assertEqual(validate_effects(failed, outcomes(False), [])['effects'], [])
        with self.assertRaisesRegex(ValueError, 'count or wire fields'):
            validate_effects(failed, outcomes(False), [row(failed)])

    def test_receipt_counter_order_and_timestamp_consistency(self):
        tx = transaction(native(), native(20))
        for ids in ((2, 1), (1, 1), (0, 1)):
            with self.assertRaisesRegex(ValueError, 'strictly ordered'):
                validate_effects(tx, outcomes(True, True), [row(tx, id=ids[0]), row(tx, amount=20, id=ids[1])])
        with self.assertRaisesRegex(ValueError, 'count or wire fields'):
            validate_effects(tx, outcomes(True, True), [row(tx, amount=20), row(tx, id=2)])
        second = row(tx, amount=20, id=2); second['timestamp'] = str(TIME + 1)
        with self.assertRaisesRegex(ValueError, 'inconsistent'):
            validate_effects(tx, outcomes(True, True), [row(tx), second])
        one = transaction(native())
        with self.assertRaisesRegex(ValueError, 'receipt count'):
            validate_effects(one, outcomes(True), [row(one), row(one, id=2)])

    def test_unknown_successes_preserve_unverified_summaries_or_absence(self):
        tx = transaction(instruction(999, b'unknown'))
        empty = validate_effects(tx, outcomes(True), [])
        self.assertEqual(empty['validation']['unparsed_successful_instructions'], [0])
        result = validate_effects(tx, outcomes(True), [row(tx, 'future_type', OTHER, RECIPIENT, 123)])
        self.assertEqual(result['effects'][0]['amount_raw'], '123')
        self.assertEqual(result['effects'][0]['validation'], 'unverified_instruction_fields')
        self.assertEqual(result['validation']['matched_receipts'], 0)
        self.assertEqual(result['addresses'], [])

    def test_unknown_missing_receipt_does_not_shift_known_instruction_or_hide_mismatch(self):
        tx = transaction(instruction(999), native())
        result = validate_effects(tx, outcomes(True, True), [row(tx)])
        self.assertEqual(result['effects'][0]['instruction_index'], 1)
        self.assertEqual(result['validation']['matched_receipts'], 1)
        with self.assertRaisesRegex(ValueError, 'count or wire fields'):
            validate_effects(tx, outcomes(True, True), [row(tx, amount=123)])

    def test_ambiguous_unknown_alignment_never_claims_verified_participants(self):
        tx = transaction(instruction(999), native(), instruction(999))
        result = validate_effects(tx, outcomes(True, True, True), [row(tx), row(tx, id=2)])
        self.assertTrue(result['validation']['alignment_ambiguous'])
        self.assertEqual(result['addresses'], [])
        self.assertEqual(result['validation']['matched_receipts'], 0)
        self.assertEqual([effect['instruction_index'] for effect in result['effects']], [None, None])
        self.assertEqual([effect['possible_instruction_indexes'] for effect in result['effects']], [[0, 1], [1, 2]])

    def test_wire_identity_and_complete_boolean_outcomes_are_required(self):
        tx = transaction(native())
        for bad_outcomes in ([], [{'index': 1, 'ok': True}], [{'index': 0, 'ok': 1}], [{'index': True, 'ok': True}]):
            with self.assertRaisesRegex(ValueError, 'outcomes'): validate_effects(tx, bad_outcomes, [row(tx)])
        for key, value in [('signature', 'wrong'), ('signer', OTHER), ('account_keys', [OTHER])]:
            bad = {**tx, key: value}
            with self.assertRaisesRegex(ValueError, 'wire mismatch'): validate_effects(bad, outcomes(True), [row(tx)])
        bad = copy.deepcopy(tx); bad['instructions'][0]['decoded']['amount_raw'] = '999'
        with self.assertRaisesRegex(ValueError, 'display/wire'): validate_effects(bad, outcomes(True), [row(tx)])

    def test_accepts_sqlite_rows_and_indexes_only_exact_base58_public_keys(self):
        tx = transaction(native(recipient='1' * 44))  # Alphabet-valid but not a 32-byte public key.
        value = row(tx, recipient='1' * 44)
        db = sqlite3.connect(':memory:'); self.addCleanup(db.close); db.row_factory = sqlite3.Row
        stored = db.execute('SELECT :id AS id,:slot AS slot,:signature AS signature,:tx_type AS tx_type,:from_addr AS from_addr,:to_addr AS to_addr,:amount AS amount,:timestamp AS timestamp', value).fetchone()
        result = validate_effects(tx, outcomes(True), [stored])
        self.assertEqual(result['addresses'], [SIGNER])
        self.assertFalse(result['validation']['block_timestamp_verified'])


if __name__ == '__main__': unittest.main()
