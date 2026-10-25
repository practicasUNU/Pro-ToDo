import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/credentials.service', () => ({
  fetchCredentials: vi.fn(),
  fetchCredentialOptions: vi.fn(),
  createCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

import * as credentialsService from '@services/credentials.service';

import { CredentialAuthType } from '@/types/credential';

import { useCredentialsStore } from './credentials.store';

const CREDENTIAL = {
  id: '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30',
  name: 'API de becas',
  authType: CredentialAuthType.BEARER_TOKEN,
  createdAt: '2026-10-24T08:00:00.000Z',
  updatedAt: '2026-10-24T08:00:00.000Z',
};

describe('useCredentialsStore (boveda)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('1.1 deberia reflejar el alta en el panel y en las opciones del nodo', async () => {
    // 1. Arrange 📐
    vi.mocked(credentialsService.createCredential).mockResolvedValue(CREDENTIAL);
    const store = useCredentialsStore();

    // 2. Act ⚙️
    await store.createCredential({
      name: CREDENTIAL.name,
      authType: CredentialAuthType.BEARER_TOKEN,
      token: 'tok',
    });

    // 3. Assert 🎯
    expect(store.credentials).toEqual([CREDENTIAL]);
    expect(store.options).toEqual([
      { id: CREDENTIAL.id, name: CREDENTIAL.name, authType: CREDENTIAL.authType },
    ]);
  });

  it('1.2 no deberia duplicar la fila si el evento del socket llega despues', async () => {
    // 1. Arrange 📐
    vi.mocked(credentialsService.createCredential).mockResolvedValue(CREDENTIAL);
    const store = useCredentialsStore();
    await store.createCredential({
      name: 'API',
      authType: CredentialAuthType.BEARER_TOKEN,
      token: 't',
    });

    // 2. Act ⚙️
    store.applyMutation('CREATED', CREDENTIAL, CREDENTIAL.id);

    // 3. Assert 🎯
    expect(store.credentials).toHaveLength(1);
    expect(store.options).toHaveLength(1);
  });

  it('1.3 deberia retirar la credencial borrada de las dos listas', async () => {
    // 1. Arrange 📐
    vi.mocked(credentialsService.deleteCredential).mockResolvedValue(CREDENTIAL);
    const store = useCredentialsStore();
    store.applyMutation('CREATED', CREDENTIAL, CREDENTIAL.id);

    // 2. Act ⚙️
    await store.deleteCredential(CREDENTIAL.id);

    // 3. Assert 🎯
    expect(store.credentials).toEqual([]);
    expect(store.options).toEqual([]);
  });

  it('1.4 deberia apagar isLoading aunque el backend rechace el borrado', async () => {
    // 1. Arrange 📐: el 409 "en uso" sube al componente, que lo muestra.
    vi.mocked(credentialsService.deleteCredential).mockRejectedValue(new Error('409'));
    const store = useCredentialsStore();

    // 2. Act ⚙️ + 3. Assert 🎯
    await expect(store.deleteCredential(CREDENTIAL.id)).rejects.toThrow('409');
    expect(store.isLoading).toBe(false);
  });
});
