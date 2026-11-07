// Offline only. Input one UUID per stdin line; no raw inputs are echoed.
import {createHash} from 'node:crypto';
let input='';for await(const chunk of process.stdin)input+=chunk;
for(const value of input.replace(/\r?\n$/, '').split(/\r?\n/))console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?createHash('sha256').update('vf-diagnostic-uuid-v1:'+value.toLowerCase(),'utf8').digest('hex'):'invalid');
