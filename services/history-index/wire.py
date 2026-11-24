"""Public Solana-compatible transaction codec. No signing or network I/O.

Wire/short-vector and Merkle formats match fresh-mainnet-node and the existing
read-only chain observer. Decoding establishes structure, not signature validity.
"""
import base64
import hashlib
import struct
import json

ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
MAX_WIRE = 262144

def require(ok, message):
    if not ok: raise ValueError(message)

def b58(data):
    number, out = int.from_bytes(data, 'big'), ''
    while number:
        number, digit = divmod(number, 58); out = ALPHABET[digit] + out
    return '1' * (len(data) - len(data.lstrip(b'\0'))) + out

def short(n):
    require(type(n) is int and 0 <= n <= 65535, 'invalid short-vector length')
    out = bytearray()
    while n >= 128: out.append((n & 127) | 128); n >>= 7
    out.append(n); return bytes(out)

def octets(value, size=None):
    require(type(value) is list and len(value) <= MAX_WIRE and all(type(x) is int and 0 <= x <= 255 for x in value), 'invalid byte array')
    require(size is None or len(value) == size, 'invalid byte length'); return bytes(value)

def vector(value):
    require(type(value) is list and value and octets(value[0]) == short(len(value)-1), 'invalid serialized short vector')
    return value[1:]

class Reader:
    def __init__(self, data): self.data, self.at = data, 0
    def take(self, n):
        require(0 <= n <= len(self.data)-self.at, 'truncated wire'); out=self.data[self.at:self.at+n]; self.at+=n; return out
    def short(self):
        encoded=bytearray()
        for i in range(3):
            x=self.take(1)[0]; encoded.append(x)
            if x < 128:
                n=sum((b & 127) << (7*i) for i,b in enumerate(encoded))
                require(bytes(encoded)==short(n), 'noncanonical short vector'); return n
        raise ValueError('oversized short vector')
    def u64(self): return struct.unpack('<Q',self.take(8))[0]
    def string(self):
        n=self.u64(); require(n <= 16384,'oversized instruction string'); return self.take(n).decode('utf8')

def describe_instruction(raw):
    """Decode common native/token/contract fields; preserve every raw instruction."""
    r=Reader(raw); out={}; addresses=[]
    try:
        variant=struct.unpack('<I',r.take(4))[0]; out['variant']=variant
        if variant in (0,1,2):
            out['type']={0:'token_mint',1:'token_transfer',2:'token_burn'}[variant]
            out['token_id']=r.string()
            if variant == 0: out['to']=r.string()
            else:
                out['from']=r.string()
                if variant == 1: out['to']=r.string()
            out['amount_raw']=str(r.u64())
        elif variant == 11:
            out.update(type='native_transfer', **{'from':r.string(),'to':r.string(),'amount_raw':str(r.u64())})
        elif variant in (13,14): out.update(type='wrap_xrs' if variant==13 else 'unwrap_xrs',amount_raw=str(r.u64()))
        elif variant == 4:
            out.update(type='contract_call',contract_id=r.string(),method=r.string())
            count=r.u64(); require(count<=MAX_WIRE,'oversized contract arguments'); args=r.take(count)
            out['args_base64']=base64.b64encode(args).decode()
            try:
                parsed=json_safe(json.loads(args));json.dumps(parsed,allow_nan=False);out['args_json']=parsed
            except (ValueError,UnicodeError,RecursionError): pass
        elif variant == 5:
            out.update(type='contract_deploy',contract_id=r.string(),contract_type=r.string(),params_json=r.string())
        else: out['type']='unparsed_instruction'
        addresses=[out[k] for k in ('from','to') if k in out and 32<=len(out[k])<=44 and all(c in ALPHABET for c in out[k])]
    except (ValueError,UnicodeError,struct.error): out={'type':'unparsed_instruction'}
    return out, addresses

def json_safe(value):
    if type(value) is int and abs(value)>2**53-1:return str(value)
    if isinstance(value,dict):return {k:json_safe(v) for k,v in value.items()}
    if isinstance(value,list):return [json_safe(v) for v in value]
    return value

def decode(encoded):
    require(type(encoded) is str and len(encoded)<=MAX_WIRE*4//3+8,'invalid wire size')
    wire=base64.b64decode(encoded,validate=True); require(base64.b64encode(wire).decode()==encoded and len(wire)<=MAX_WIRE,'noncanonical base64')
    r=Reader(wire); count=r.short(); require(1<=count<=64,'invalid signatures')
    signatures=[b58(r.take(64)) for _ in range(count)]
    required,rs,ru=r.take(3); require(required==count and rs<required,'invalid signer header')
    n=r.short(); require(count<=n<=256 and ru<=n-count,'invalid accounts')
    keys=[b58(r.take(32)) for _ in range(n)]; recent=r.take(32).hex(); n_ix=r.short(); require(1<=n_ix<=256,'invalid instruction count')
    instructions=[]; addresses=set(keys)
    for i in range(n_ix):
        program=r.take(1)[0]; accounts=list(r.take(r.short())); raw=r.take(r.short())
        require(program<len(keys) and all(x<len(keys) for x in accounts),'invalid account index')
        details,embedded=describe_instruction(raw); addresses.update(embedded)
        instructions.append({'index':i,'program_id':keys[program],'accounts':[keys[x] for x in accounts], 'data_base64':base64.b64encode(raw).decode(),'decoded':details})
    require(r.at==len(wire),'trailing transaction bytes')
    return {'signature':signatures[0],'signatures':signatures,'signer':keys[0],'account_keys':keys,'recent_blockhash':recent,'instructions':instructions,'addresses':sorted(addresses),'wire_base64':encoded},wire

def encode(tx):
    require(type(tx) is dict and set(tx)=={'signatures','message'},'invalid raw transaction')
    m=tx['message']
    # Node JSONL uses SDK camelCase; public getBlock uses normalized snake_case.
    camel={'header','accountKeys','recentBlockhash','instructions'}
    snake={'header','account_keys','recent_blockhash','instructions'}
    require(type(m) is dict and set(m) in (camel,snake),'invalid raw message fields')
    if set(m)==camel:
        h=m['header'];require(set(h)=={'numRequiredSignatures','numReadonlySignedAccounts','numReadonlyUnsignedAccounts'},'invalid raw header')
        m={'header':{'num_required_signatures':h['numRequiredSignatures'],'num_readonly_signed_accounts':h['numReadonlySignedAccounts'],'num_readonly_unsigned_accounts':h['numReadonlyUnsignedAccounts']},
           'account_keys':m['accountKeys'],'recent_blockhash':m['recentBlockhash'],
           'instructions':[m['instructions'][0],*[{'program_id_index':i['programIdIndex'],'accounts':i['accounts'],'data':i['data']} for i in m['instructions'][1:]]]}
    sigs=vector(tx['signatures']);h=m['header'];keys=vector(m['account_keys']);instructions=vector(m['instructions'])
    out=short(len(sigs))+b''.join(octets(s,64) for s in sigs)+octets([h[k] for k in ('num_required_signatures','num_readonly_signed_accounts','num_readonly_unsigned_accounts')],3)
    out+=short(len(keys))+b''.join(octets(k,32) for k in keys)+octets(m['recent_blockhash'],32)+short(len(instructions))
    for ix in instructions:
        ac=vector(ix['accounts']);data=vector(ix['data']);out+=octets([ix['program_id_index']],1)+short(len(ac))+octets(ac)+short(len(data))+octets(data)
    encoded=base64.b64encode(out).decode();decode(encoded);return encoded

def merkle(wires):
    if not wires:return hashlib.sha256(b'\x01XRS_MERKLE_EMPTY_V2').hexdigest()
    layer=[hashlib.sha256(b'\x00'+x).digest() for x in wires];pad=hashlib.sha256(b'\x01XRS_MERKLE_ODD_PAD_V2').digest()
    while len(layer)>1:layer=[hashlib.sha256(b'\x01'+layer[i]+(layer[i+1] if i+1<len(layer) else pad)).digest() for i in range(0,len(layer),2)]
    return layer[0].hex()

def work_hash(block):
    """Recompute unchanged v4 node pow.rs header commitment, not consensus.

    PoW v2 activates at slot 1; scrypt N=4096,r=4,p=1 applies from slot 0.
    Genesis has an empty parent. Producer certificates/difficulty are not checked.
    """
    slot=block['slot'];nonce=block['nonce'];timestamp=block['poh_timestamp']
    require(type(slot) is int and 0<slot<2**64,'invalid work slot')
    require(type(nonce) is int and 0<=nonce<2**64,'invalid work nonce')
    require(type(timestamp) is int and 0<timestamp<2**128,'invalid work timestamp')
    proposer=octets(block['proposer'],32);parent=octets(block['previous_hash'])
    require(len(parent)==32 or (slot==1 and parent==b''),'invalid work parent')
    poh=octets(block['poh_hash'],32);root=octets(block['merkle_root'],32)
    envelope=octets(block['proposer_sig']);require(0<len(envelope)<=MAX_WIRE,'invalid recovery envelope')
    sized=lambda value:len(value).to_bytes(4,'little')+value
    old=b'XRS_POW_V2'+slot.to_bytes(8,'little')+proposer+sized(parent)+timestamp.to_bytes(16,'little')+sized(poh)+nonce.to_bytes(8,'big')+sized(root)
    preimage=b'XRS_POW_MAINNET_V4\0'+sized(b'xeris-mainnet-v4')+sized(old)+sized(envelope)
    return hashlib.scrypt(preimage,salt=b'',n=4096,r=4,p=1,dklen=32).hex()
