/**
 * A loopback port on this machine whose every connection is carried over a sandbox's channel to a port inside the
 * sandbox. It is how multi-host reaches the DSH runtime of a runtime-mode sandbox, which has no network.
 */
import { createServer, type Socket } from 'node:net'
import type { GuestChannel } from '@dshfiles/sandbox-guest/channel'
import { Effect } from 'effect'
import { SandboxStepFailed } from './errors.ts'

export interface LoopbackForward {
  readonly port: number
  readonly close: Effect.Effect<void>
}

const relay = (local: Socket, channel: GuestChannel, port: number): void => {
  local.pause()
  channel.connect(port).then(
    remote => {
      local.pipe(remote)
      remote.pipe(local)
      local.resume()
      local.on('error', () => remote.destroy())
      remote.on('error', () => local.destroy())
    },
    () => local.destroy(),
  )
}

export class LoopbackForwards {
  static open(id: string, channel: GuestChannel, innerPort: number): Effect.Effect<LoopbackForward, SandboxStepFailed> {
    return Effect.callback<LoopbackForward, SandboxStepFailed>(resume => {
      const sockets = new Set<Socket>()
      const server = createServer(local => {
        sockets.add(local)
        local.once('close', () => sockets.delete(local))
        relay(local, channel, innerPort)
      })
      const refuse = (detail: string, cause?: unknown) =>
        resume(
          Effect.fail(
            new SandboxStepFailed({
              id,
              step: 'open its runtime port',
              detail,
              recovery: 'Retry; if it persists, check that this machine can listen on 127.0.0.1.',
              cause,
            }),
          ),
        )
      server.once('error', error => refuse(error.message, error))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          refuse('the forward has no TCP address')
          return
        }
        const close = Effect.callback<void>(done => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done(Effect.void))
        })
        resume(Effect.succeed({ port: address.port, close }))
      })
    })
  }
}
