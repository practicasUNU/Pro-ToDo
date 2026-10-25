import { AuditTable } from '@modules/audit/audit-tables';
import {
  AuditSnapshotService,
  MAX_SNAPSHOT_STRING,
  sanitizeSnapshot,
} from '@modules/audit/services/audit-snapshot.service';
import { User } from '@modules/users/entities/user.entity';

import type { DataSource } from 'typeorm';

const USER_ID = '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20';

/** Entidad cargada como relacion: lo que nunca debe entrar en la fotografia. */
class LoadedRelation {
  constructor(public readonly email: string) {}
}

describe('AuditSnapshotService', () => {
  describe('sanitizeSnapshot', () => {
    it('1.1 deberia eliminar secretos, tokens y relaciones cargadas', () => {
      // 1. Arrange 📐
      const source = {
        id: USER_ID,
        email: 'admin@unuware.com',
        otpSecret: 'JBSWY3DPEHPK3PXP',
        refreshToken: 'opaco',
        createdBy: new LoadedRelation('otro@unuware.com'),
        createdAt: new Date('2026-10-22T08:30:00.000Z'),
      };

      // 2. Act ⚙️
      const snapshot = sanitizeSnapshot(source);

      // 3. Assert 🎯
      expect(snapshot).toEqual({
        id: USER_ID,
        email: 'admin@unuware.com',
        createdAt: '2026-10-22T08:30:00.000Z',
      });
    });

    it('1.2 deberia conservar los JSONB planos y recortar las cadenas enormes', () => {
      // 1. Arrange 📐
      const source = {
        pipelineSchema: {
          nodes: [{ nodeId: 'n1', params: { apiToken: 'x' } }],
        },
        htmlContent: 'a'.repeat(MAX_SNAPSHOT_STRING + 50),
      };

      // 2. Act ⚙️
      const snapshot = sanitizeSnapshot(source);

      // 3. Assert 🎯: la limpieza es recursiva dentro del JSONB.
      expect(snapshot.pipelineSchema).toEqual({
        nodes: [{ nodeId: 'n1', params: {} }],
      });
      expect(String(snapshot.htmlContent)).toContain('[recortado:');
    });
  });

  describe('load', () => {
    it('2.1 deberia leer la fila por id desde el repositorio de la tabla', async () => {
      // 1. Arrange 📐
      const repository = {
        findOne: jest.fn().mockResolvedValue({
          id: USER_ID,
          email: 'admin@unuware.com',
          role: 'ADMIN',
        }),
      };
      const dataSource = { getRepository: jest.fn(() => repository) };
      const service = new AuditSnapshotService(
        dataSource as unknown as DataSource,
      );

      // 2. Act ⚙️
      const snapshot = await service.load(AuditTable.USERS, USER_ID);

      // 3. Assert 🎯
      expect(dataSource.getRepository).toHaveBeenCalledWith(User);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: USER_ID },
      });
      expect(snapshot).toEqual({
        id: USER_ID,
        email: 'admin@unuware.com',
        role: 'ADMIN',
      });
    });

    it('2.2 deberia devolver null si el registro ya no existe', async () => {
      // 1. Arrange 📐: baja fisica (allowed_ips).
      const repository = { findOne: jest.fn().mockResolvedValue(null) };
      const service = new AuditSnapshotService({
        getRepository: () => repository,
      } as unknown as DataSource);

      // 2. Act ⚙️
      const snapshot = await service.load(AuditTable.ALLOWED_IPS, USER_ID);

      // 3. Assert 🎯
      expect(snapshot).toBeNull();
    });
  });

  describe('credenciales (enmascarado obligatorio)', () => {
    const CREDENTIAL_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';

    const loadCredential = async (
      row: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      const repository = { findOne: jest.fn().mockResolvedValue(row) };
      const service = new AuditSnapshotService({
        getRepository: () => repository,
      } as unknown as DataSource);

      return service.load(AuditTable.CREDENTIALS, CREDENTIAL_ID);
    };

    it('3.1 deberia enmascarar los campos secretos y omitir el cifrado', async () => {
      // 1. Arrange 📐: aunque alguien cargase las columnas criptograficas con
      //    `addSelect`, ni el cifrado ni el IV ni la etiqueta pueden auditarse.
      const row = {
        id: CREDENTIAL_ID,
        name: 'API de becas',
        authType: 'BASIC_AUTH',
        encryptedData: 'Y2lmcmFkbw==',
        iv: 'aXY=',
        authTag: 'dGFn',
        createdAt: new Date('2026-10-24T08:00:00.000Z'),
      };

      // 2. Act ⚙️
      const snapshot = await loadCredential(row);

      // 3. Assert 🎯
      expect(snapshot).toEqual({
        id: CREDENTIAL_ID,
        name: 'API de becas',
        authType: 'BASIC_AUTH',
        createdAt: '2026-10-24T08:00:00.000Z',
        credentialData: { username: '********', password: '********' },
      });
      expect(JSON.stringify(snapshot)).not.toContain('Y2lmcmFkbw==');
    });

    it('3.2 deberia enmascarar token y apiKey segun el tipo', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const bearer = await loadCredential({
        id: CREDENTIAL_ID,
        authType: 'BEARER_TOKEN',
      });
      const apiKey = await loadCredential({
        id: CREDENTIAL_ID,
        authType: 'API_KEY',
      });

      // 3. Assert 🎯
      expect(bearer?.credentialData).toEqual({ token: '********' });
      expect(apiKey?.credentialData).toEqual({
        keyName: '********',
        apiKey: '********',
        placement: '********',
      });
    });
  });
});
