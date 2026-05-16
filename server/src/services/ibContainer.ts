// Controls the IBeam container via the host Docker daemon (socket mounted at
// /var/run/docker.sock in this api container). The user starts/stops the
// container from the Upside FE — see UPSIDE_MVP_SPEC.md → "IB Authentication
// Flow" for the rationale (IBKR's single-session-per-account limit means
// IBeam must be off when the user wants to use IBKR Mobile).

import Docker from 'dockerode';

const docker = new Docker(); // unix:///var/run/docker.sock by default

const CONTAINER_NAME = process.env.IB_GATEWAY_CONTAINER ?? 'upside-ib-gateway-1';

export type IbContainerState = 'running' | 'stopped' | 'missing';

export async function getIbContainerState(): Promise<IbContainerState> {
  try {
    const info = await docker.getContainer(CONTAINER_NAME).inspect();
    return info.State.Running ? 'running' : 'stopped';
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404) return 'missing';
    throw e;
  }
}

export async function startIbContainer(): Promise<void> {
  const c = docker.getContainer(CONTAINER_NAME);
  const info = await c.inspect();
  if (info.State.Running) return;
  await c.start();
}

export async function stopIbContainer(): Promise<void> {
  const c = docker.getContainer(CONTAINER_NAME);
  const info = await c.inspect();
  if (!info.State.Running) return;
  // t=10 gives Python a chance to clean up Selenium / Chrome before SIGKILL.
  await c.stop({ t: 10 });
}
