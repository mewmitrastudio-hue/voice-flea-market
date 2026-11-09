// Pure policy checks. All context comes from the operator-authorized database,
// not client-supplied prices. Approval records facts; it never moves money.
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const fail=x=>{throw Error('financial_resolution_'+x)};
function identity(c){const p=c?.payment;if(!p||!uuid(p.id)||p.payment_channel!=='ios'||p.apple_environment!=='Production'||!p.apple_verified_at||!Number.isSafeInteger(p.amount_jpy)||p.amount_jpy<=0)fail('verified_production_purchase_required');return p;}
function micro(value){if(typeof value!=='string'||!/^\d{1,12}(?:\.\d{1,6})?$/.test(value))fail('report_amount_invalid');const [a,b='']=value.split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));}
export function adjustmentPreview(context,{reportId,lineNumber,note}){
 const p=identity(context),r=context.report;
 if(!uuid(reportId)||r?.id!==reportId||!Number.isInteger(lineNumber)||lineNumber<2||typeof note!=='string'||note.trim().length<10||note.length>2000)fail('report_selection_required');
 const row=r.snapshot?.rows?.find(x=>x.line===lineNumber);
 if(!row||row.kind!=='R'||row.quantity!==-1||row.currency!=='JPY'||row.customerCurrency!=='JPY'||row.country!=='JP'||row.sku!=='com.ayuhide.koenofurima.voice.jpy'+p.amount_jpy)fail('single_jpy_return_required');
 // A report row is aggregate evidence; only one-unit rows can use this narrow
 // operator-association workflow. Multi-unit mappings need a separate design.
 if(typeof row.customerPrice!=='string'||!/^-(?:[1-9]\d*)(?:\.0{1,6})?$/.test(row.customerPrice))fail('exact_customer_refund_required');
 const customerRefundJpy=Number(row.customerPrice)*-1;
 if(!Number.isSafeInteger(customerRefundJpy)||customerRefundJpy>p.amount_jpy)fail('customer_refund_mismatch');
 if(typeof row.proceeds!=='string'||!/^-(?:\d+)(?:\.\d{1,6})?$/.test(row.proceeds)||micro(row.proceeds.slice(1))!==micro(row.unitProceeds))fail('report_debit_mismatch');
 return {kind:'adjustment',paymentId:p.id,reportId,lineNumber,transactionId:p.apple_transaction_id,customerRefundJpy,appleNetDebit:row.unitProceeds,
  settlementComplete:false,reviewRequired:true,holdReason:'追加費用・回収不足・端数配分を確定せず保留します。承認は報告書の対応付けのみで、返金・回収・送金は行いません。',note:note.trim()};
}
export function bankReceiptPreview(context,input,verification){
 const p=identity(context),o=context.operation,a=context.allocation,v=verification;
 if(!o||!a||o.payment_id!==p.id||o.transfer_id!==v?.transferId||o.destination!==v?.destination||o.amount_jpy!==a.seller_amount_jpy||v.assignmentVerified!==true||v.stripePayoutPaid!==true)fail('bank_assignment_required');
 if(!/^[a-f0-9]{64}$/i.test(input.bankStatementSha256||'')||typeof input.bankReference!=='string'||input.bankReference.trim().length<4||input.bankReference.length>180||typeof input.note!=='string'||input.note.trim().length<10||input.note.length>2000)fail('bank_statement_required');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedDate||'')||new Date(input.receivedDate+'T00:00:00Z').toISOString().slice(0,10)!==input.receivedDate)fail('bank_date_invalid');
 if(!Number.isSafeInteger(input.receivedAmountJpy)||input.receivedAmountJpy!==v.payoutAmountJpy)fail('bank_receipt_amount_mismatch');
 const eligible=p.status==='paid'&&p.refunded_amount_jpy===0&&o.state==='transferred'&&o.reversed_jpy===0&&a.state==='allocated_unpaid'&&!context.refundReviewRequired&&v.creditFeeJpy===0&&v.creditNetJpy===a.seller_amount_jpy&&v.payoutAmountJpy>=a.seller_amount_jpy&&v.batchAllPositiveNoFees===true&&v.batchMatchesPayout===true&&v.batchNetTotalJpy===v.payoutAmountJpy;
 return {kind:'bank',paymentId:p.id,transferId:o.transfer_id,destination:o.destination,payoutId:v.payoutId,bankAccountId:input.bankAccountId,balanceTransactionId:v.balanceTransactionId,
  sellerAmountJpy:a.seller_amount_jpy,batchAllPositiveNoFees:v.batchAllPositiveNoFees===true,batchMatchesPayout:v.batchMatchesPayout===true,batchNetTotalJpy:v.batchNetTotalJpy??null,creditFeeJpy:v.creditFeeJpy,creditNetJpy:v.creditNetJpy,payoutAmountJpy:v.payoutAmountJpy,receivedAmountJpy:input.receivedAmountJpy,
  bankStatementSha256:input.bankStatementSha256.toLowerCase(),bankReference:input.bankReference.trim(),receivedDate:input.receivedDate,note:input.note.trim(),
  settlementComplete:false,eligibleForSettlement:eligible,reviewRequired:!eligible,holdReason:eligible?'銀行明細原本と入金額・照合キーを確認して承認してください。':'返金・追加費用・不足債務または未完精算があり、銀行証拠を記録しても精算は完了しません。'};
}
