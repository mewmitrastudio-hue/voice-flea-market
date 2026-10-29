// Apple financial reports contain aggregate units, not App Store transaction IDs.
// Parsing a document never proves bank receipt or authorizes a seller payment.
const SCALE=1000000n;
const required=['Start Date','End Date','Quantity','Partner Share','Extended Partner Share','Partner Share Currency','Sale or Return','Country of Sale','Customer Price','Customer Currency'];
const fail=message=>{throw new Error(message);};
function date(value){
 const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
 if(!m)fail('日付の形式を確認してください。');
 const iso=`${m[3]}-${m[1]}-${m[2]}`,d=new Date(`${iso}T00:00:00Z`);
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==iso)fail('存在しない日付です。');
 return iso;
}
function money(value){
 if(!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value))fail('金額の形式または精度を確認してください。');
 const negative=value.startsWith('-'),[whole,decimal='']=value.replace(/^-/,'').split('.');
 return (BigInt(whole)*SCALE+BigInt(decimal.padEnd(6,'0')))*(negative?-1n:1n);
}
function decimal(value){const sign=value<0n?'-':'';value=value<0n?-value:value;return sign+String(value/SCALE)+'.'+String(value%SCALE).padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');}
export function parseAppleFinancialReport(text){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>1048576||text.includes('\0'))fail('1MB以下の財務レポート（テキスト）を選んでください。');
 const lines=text.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').split('\n');
 while(lines.at(-1)==='')lines.pop();
 if(lines.length<2||lines.length>10001)fail('明細のある財務レポートを選んでください。');
 const headers=lines.shift().split('\t');
 if(new Set(headers).size!==headers.length||!required.every(h=>headers.includes(h)))fail('Apple財務レポートの列を確認してください。売上予測レポートは取り込めません。');
 const skuKey=headers.includes('Vendor Identifier')?'Vendor Identifier':headers.includes('SKU')?'SKU':null;
 if(!skuKey)fail('商品IDの列がありません。');
 const rows=[],totals=new Map();let start,end;
 for(const [index,line] of lines.entries()){
  const cells=line.split('\t');if(cells.length!==headers.length)fail(`${index+2}行目の列数が一致しません。`);
  const row=Object.fromEntries(headers.map((h,i)=>[h,cells[i]]));
  const from=date(row['Start Date']),to=date(row['End Date']);
  if(from>to||start&&start!==from||end&&end!==to)fail('異なる会計期間を混在させず、元のレポートを選んでください。');
  start=from;end=to;
  if(!/^-?[1-9]\d{0,8}$/.test(row.Quantity))fail('販売・返品数量を確認してください。');
  const quantity=Number(row.Quantity),share=money(row['Partner Share']),net=money(row['Extended Partner Share']),price=money(row['Customer Price']);
  const kind=row['Sale or Return'],currency=row['Partner Share Currency'],customerCurrency=row['Customer Currency'],country=row['Country of Sale'];
  if(!['S','R'].includes(kind)||kind==='S'&&quantity<0||kind==='R'&&quantity>0||share<0n||net!==share*BigInt(quantity)||kind==='S'&&price<0n||kind==='R'&&price>0n)fail('販売・返品の符号または受取額の合計が一致しません。');
  if(!/^[A-Z]{3}$/.test(currency)||!/^[A-Z]{3}$/.test(customerCurrency)||!/^[A-Z]{2}$/.test(country)||!row[skuKey]||row[skuKey].length>255)fail('通貨・販売国・商品IDを確認してください。');
  const sku=row[skuKey],supported=/^com\.ayuhide\.koenofurima\.(?:voice\.jpy(?:1000|1500)|boost\.(?:silver|gold|platinum))$/.test(sku);
  rows.push({line:index+2,sku,kind,quantity,country,currency,customerCurrency,unitProceeds:decimal(share),proceeds:decimal(net),customerPrice:decimal(price),supported});
  const key=JSON.stringify([supported,currency]),total=totals.get(key)||{supported,currency,saleUnits:0,returnUnits:0,net:0n};
  if(kind==='S')total.saleUnits+=quantity;else total.returnUnits-=quantity;total.net+=net;totals.set(key,total);
 }
 return {periodStart:start,periodEnd:end,rowCount:rows.length,rows,totals:[...totals.values()].map(({net,...t})=>({...t,proceeds:decimal(net)})),state:'document_imported_unreconciled'};
}
export async function appleFinancialReportSnapshot(text,name='financial-report.txt'){
 const report=parseAppleFinancialReport(text);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return {...report,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join(''),sourceName:String(name).replace(/[\x00-\x1f\x7f]/g,'').slice(0,180)};
}
