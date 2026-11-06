import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm'
import { x402Client, x402HTTPClient } from '@x402/fetch'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { privateKeyToAccount } from 'viem/accounts'
import { BASE_SEPOLIA_NETWORK } from '../../src/lib/payment-config.ts'
import { paymentRequiredForApproval } from './payment-policy.ts'

/** 自動決済用の専用ウォレット。少額だけ入れた鍵を X402_AGENT_PRIVATE_KEY で渡す。 */
export function getAgentAccount() {
  const key = process.env.X402_AGENT_PRIVATE_KEY
  if (!key || !/^0x[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error('X402_AGENT_PRIVATE_KEY (0x + 64 hex) is required for mandate payments')
  }
  return privateKeyToAccount(key as `0x${string}`)
}

/** 選んだ支払い条件にエージェントの鍵で署名し、PAYMENT-SIGNATUREヘッダーの値を返す。 */
export async function signPayment(required: PaymentRequired, requirement: PaymentRequirements) {
  const account = getAgentAccount()
  const signer = toClientEvmSigner({
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData as never),
  })
  const httpClient = new x402HTTPClient(new x402Client().register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme(signer)))
  const payload = await httpClient.createPaymentPayload(paymentRequiredForApproval(required, requirement))
  const headers = httpClient.encodePaymentSignatureHeader(payload)
  const header = headers['PAYMENT-SIGNATURE'] ?? headers['payment-signature']
  if (!header) throw new Error('Could not create the x402 payment signature')
  return header
}
