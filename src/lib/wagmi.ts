import { coinbaseWallet, injected } from '@wagmi/connectors'
import { createConfig, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: 'Signal Journal' }),
  ],
  transports: { [baseSepolia.id]: http() },
  ssr: true,
})
