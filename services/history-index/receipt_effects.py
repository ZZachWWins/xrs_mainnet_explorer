"""Pure matching of node receipt summaries to canonical signed transaction wire.

Mirrors ledger.rs build_receipt (1630–1685) and tx_store.rs (261–269, 371).
These are receipt summaries, not every balance change, fee, contract-internal
effect, or independent proof of execution. Unknown instructions remain unverified.
No database, filesystem, network, signing, or validator imports.
"""
import base64
import re
import struct
from wire import ALPHABET, MAX_WIRE, Reader, decode, require

U64 = 2**64 - 1
I64_MIN, I64_MAX = -(2**63), 2**63 - 1


def _address(value):
    if type(value) is not str or not 32 <= len(value) <= 44 or any(c not in ALPHABET for c in value):
        return False
    number = 0
    for char in value:
        number = number * 58 + ALPHABET.index(char)
    return len(value) - len(value.lstrip('1')) + (number.bit_length() + 7) // 8 == 32


def _timestamp(value):
    if type(value) is int:
        require(0 <= value < 2**128, 'invalid block timestamp')
        return str(value)
    require(type(value) is str and len(value) <= 39 and re.fullmatch(r'0|[1-9][0-9]*', value)
            and int(value) < 2**128, 'invalid receipt timestamp')
    return value


def _expected(instruction, signer):
    """Return known build_receipt fields or None for an unparsed instruction."""
    details = instruction['decoded']
    kind = details['type']
    if kind in ('native_transfer', 'token_transfer'):
        return kind, details['from'], details['to'], int(details['amount_raw'])
    if kind == 'token_mint':
        return kind, signer, details['to'], int(details['amount_raw'])
    if kind in ('wrap_xrs', 'unwrap_xrs'):
        return kind, signer, '', int(details['amount_raw'])
    if kind == 'contract_call':
        return kind, signer, details['contract_id'], 0
    # Deliberately mirror the node's default arm: a burn is NOT a transfer
    # receipt, and a deployment's receipt contains no contract ID or amount.
    if kind in ('token_burn', 'contract_deploy'):
        return 'other', signer, '', 0
    # Other explicit build_receipt arms whose fields the display codec does
    # not yet label. Only the receipt-bearing prefix is interpreted here.
    try:
        r = Reader(base64.b64decode(instruction['data_base64'], validate=True))
        variant = struct.unpack('<I', r.take(4))[0]
        if variant in (9, 10):
            return 'stake' if variant == 9 else 'unstake', r.string(), '', r.u64()
        if variant == 12:
            return 'attestation', r.string(), '', 0
        if variant == 48:
            r.string()  # token ID is not represented by the node receipt.
            return 'zk_private_transfer', r.string(), r.string(), 0
        if variant == 52:
            return 'pq_transfer', r.string(), r.string(), r.u64()
    except (ValueError, UnicodeError, struct.error):
        pass
    return None


def validate_effects(tx, outcomes, receipt_rows, block_timestamp=None):
    """Validate a transaction's ordered public SQLite receipt rows.

    ``tx`` supplies wire_base64, signature and slot; supplied display fields
    must agree with a fresh wire decode. ``outcomes`` is the complete ordered
    [{index: int, ok: bool}] list. Rows may be dicts or sqlite.Row objects and
    must be ordered by increasing receipt id. Signed SQLite i64 amounts are
    reinterpreted as the original u64, matching the node exactly.

    Known successful instructions require exactly their expected receipt (or
    none when both participants are empty). Failed instructions consume none.
    An unparsed successful instruction may consume zero or one receipt; those
    rows are preserved without claiming their fields or participants match.
    Ambiguous alignment is disclosed instead of assigning a false ix index.

    Returns {effects, addresses, validation}. Amounts, ids and timestamps are
    decimal strings. Only wire-matched, valid 32-byte base58 participants enter
    ``addresses``. Does not validate the supplied outcome's execution itself.
    """
    require(type(tx) is dict and type(tx.get('slot')) is int and 0 < tx['slot'] < 2**53,
            'invalid transaction identity')
    decoded, _ = decode(tx.get('wire_base64'))
    require(tx.get('signature') == decoded['signature'], 'transaction signature/wire mismatch')
    for key in ('signatures', 'signer', 'instructions', 'account_keys'):
        if key in tx:
            require(tx[key] == decoded[key], 'transaction display/wire mismatch')
    instructions = decoded['instructions']
    require(type(outcomes) in (list, tuple) and len(outcomes) == len(instructions)
            and all(type(value) is dict and type(value.get('index')) is int and value['index'] == i
                    and type(value.get('ok')) is bool for i, value in enumerate(outcomes)),
            'incomplete or invalid instruction outcomes')
    require(type(receipt_rows) in (list, tuple) and len(receipt_rows) <= len(instructions),
            'invalid receipt count')
    timestamp = _timestamp(block_timestamp) if block_timestamp is not None else None
    rows, row_fields, previous_id = [], [], 0
    for raw in receipt_rows:
        try:
            row = dict(raw)
        except (TypeError, ValueError) as error:
            raise ValueError('invalid receipt row') from error
        require(type(row.get('id')) is int and previous_id < row['id'] <= I64_MAX, 'receipt ids not strictly ordered')
        previous_id = row['id']
        require(type(row.get('slot')) is int and row['slot'] == tx['slot'] and row.get('signature') == tx['signature'],
                'receipt signature/slot mismatch')
        require(all(type(row.get(key)) is str and len(row[key]) <= MAX_WIRE for key in ('tx_type', 'from_addr', 'to_addr'))
                and 0 < len(row['tx_type']) <= 128, 'invalid receipt text')
        require(type(row.get('amount')) is int and I64_MIN <= row['amount'] <= I64_MAX, 'invalid SQLite signed amount')
        amount = row['amount'] & U64
        actual_time = _timestamp(row.get('timestamp'))
        if timestamp is not None:
            require(actual_time == timestamp, 'receipt/block timestamp mismatch')
        if rows:
            require(actual_time == rows[0]['timestamp'], 'inconsistent receipt timestamps')
        row_fields.append((row['tx_type'], row['from_addr'], row['to_addr'], amount))
        rows.append({'receipt_id': str(row['id']), 'slot': row['slot'], 'signature': row['signature'],
                     'tx_type': row['tx_type'], 'from': row['from_addr'], 'to': row['to_addr'],
                     'amount_raw': str(amount), 'sqlite_amount_signed': str(row['amount']), 'timestamp': actual_time})

    expected, unknown = [], []
    for i, instruction in enumerate(instructions):
        if not outcomes[i]['ok']:
            expected.append(('skip', None))
            continue
        fields = _expected(instruction, decoded['signer'])
        if fields is None:
            expected.append(('unknown', None)); unknown.append(i)
        elif fields[1] == '' and fields[2] == '':
            expected.append(('skip', None))
        else:
            expected.append(('known', fields))

    # Ordered dynamic alignment permits missing unknown summaries without
    # allowing them to hide a missing or mismatched known instruction receipt.
    n, m = len(expected), len(rows)
    def next_positions(i, j):
        kind, fields = expected[i]
        if kind == 'skip': return (j,)
        if kind == 'unknown': return (j, j + 1) if j < m else (j,)
        return (j + 1,) if j < m and row_fields[j] == fields else ()

    forward = [[False] * (m + 1) for _ in range(n + 1)]
    forward[0][0] = True
    for i in range(n):
        for j in range(m + 1):
            if forward[i][j]:
                for after in next_positions(i, j): forward[i + 1][after] = True
    require(forward[n][m], 'receipt count or wire fields mismatch')
    backward = [[False] * (m + 1) for _ in range(n + 1)]
    backward[n][m] = True
    for i in range(n - 1, -1, -1):
        for j in range(m + 1):
            backward[i][j] = any(backward[i + 1][after] for after in next_positions(i, j))
    owners = [set() for _ in rows]
    for i in range(n):
        for j in range(m):
            if forward[i][j] and j + 1 in next_positions(i, j) and backward[i + 1][j + 1]:
                owners[j].add(i)
    addresses, matched = set(), 0
    for row, candidates in zip(rows, owners):
        require(candidates, 'unmapped receipt')
        verified = all(expected[i][0] == 'known' for i in candidates)
        row['instruction_index'] = next(iter(candidates)) if len(candidates) == 1 else None
        row['possible_instruction_indexes'] = sorted(candidates)
        row['validation'] = 'wire_fields_match' if verified else 'unverified_instruction_fields'
        if verified:
            matched += 1
            addresses.update(value for value in (row['from'], row['to']) if _address(value))
    return {'effects': rows, 'addresses': sorted(addresses),
            'validation': {'matched_receipts': matched, 'unverified_receipts': m - matched,
                           'unparsed_successful_instructions': unknown,
                           'alignment_ambiguous': any(len(values) != 1 for values in owners),
                           'block_timestamp_verified': timestamp is not None}}
