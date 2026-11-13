import type { Socket, TCPSocketListener } from 'bun';

/**
 * Proxy TCP de teste (D46): simula o PostgreSQL congelado sem docker.sock.
 * - `pass`: encaminha nos dois sentidos.
 * - `blackhole`: aceita conexões e bytes, mas não entrega nada (nem responde): o cliente só
 *   desiste pelo próprio timeout.
 * Voltar a `pass` derruba as conexões antigas (o pool abre conexões novas).
 */
export type ProxyMode = 'pass' | 'blackhole';

interface Side {
  socket: Socket<Link> | undefined;
  pending: Uint8Array[];
}

interface Link {
  client: Side;
  upstream: Side;
  closed: boolean;
}

export interface TcpProxy {
  readonly port: number;
  mode(next: ProxyMode): void;
  stop(): void;
}

function flush(side: Side): void {
  const socket = side.socket;
  if (socket === undefined) return;
  while (side.pending.length > 0) {
    const chunk = side.pending[0];
    if (chunk === undefined) break;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      side.pending[0] = chunk.subarray(written);
      return;
    }
    side.pending.shift();
  }
}

function deliver(side: Side, chunk: Uint8Array): void {
  side.pending.push(new Uint8Array(chunk));
  flush(side);
}

export function startTcpProxy(target: { hostname: string; port: number }): TcpProxy {
  let current: ProxyMode = 'pass';
  const links = new Set<Link>();

  const close = (link: Link): void => {
    if (link.closed) return;
    link.closed = true;
    links.delete(link);
    link.client.socket?.end();
    link.upstream.socket?.end();
  };

  const listener: TCPSocketListener<Link> = Bun.listen<Link>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(clientSocket) {
        const link: Link = {
          client: { socket: clientSocket, pending: [] },
          upstream: { socket: undefined, pending: [] },
          closed: false,
        };
        clientSocket.data = link;
        links.add(link);
        if (current === 'blackhole') return;
        void Bun.connect<Link>({
          hostname: target.hostname,
          port: target.port,
          data: link,
          socket: {
            open(upstreamSocket) {
              link.upstream.socket = upstreamSocket;
              flush(link.upstream);
            },
            data(_upstreamSocket, chunk) {
              if (current === 'pass' && !link.closed) deliver(link.client, chunk);
            },
            drain() {
              flush(link.upstream);
            },
            close() {
              close(link);
            },
            error() {
              close(link);
            },
          },
        }).catch(() => close(link));
      },
      data(clientSocket, chunk) {
        if (current === 'pass') deliver(clientSocket.data.upstream, chunk);
      },
      drain(clientSocket) {
        flush(clientSocket.data.client);
      },
      close(clientSocket) {
        close(clientSocket.data);
      },
      error(clientSocket) {
        close(clientSocket.data);
      },
    },
  });

  return {
    port: listener.port,
    mode(next: ProxyMode): void {
      if (next === current) return;
      const wasBlackhole = current === 'blackhole';
      current = next;
      // Ao sair do blackhole as conexões antigas ficaram com bytes perdidos: são derrubadas.
      if (wasBlackhole) for (const link of [...links]) close(link);
    },
    stop(): void {
      for (const link of [...links]) close(link);
      listener.stop(true);
    },
  };
}
