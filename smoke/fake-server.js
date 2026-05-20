import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { try { const req = JSON.parse(line); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[]}})+'\n'); } catch {} });
rl.on('close', () => process.exit(0));
