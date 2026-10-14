import { describe, expect, it } from 'bun:test';
import { Effect, Layer } from 'effect';
import { configLayer } from '../../../src/engine/config.js';
import {
  fillMissing,
  parseP4SetOutput,
  parseP4vApplicationSettingsXml,
  parseP4vConnectionMapXml,
  parseP4vConnectionString,
} from '../../../src/connection/settings.js';
import { resolveConnection } from '../../../src/node/connection.js';
import { recordingExecutor, replayExecutor } from '../../../src/testing/executor.js';
import { corpus } from '../../support/corpus.js';

describe('settings parsers', () => {
  it('reads p4 set -q output, including the charset', () => {
    expect(parseP4SetOutput(corpus.get('settings')?.stdout ?? '')).toEqual({
      port: '<LOCAL_PORT>',
      user: 'p4ts-e2e',
      client: 'p4ts_e2e_client',
      charset: 'utf8',
    });
  });

  it('reads full and partial P4V connection strings', () => {
    expect(parseP4vConnectionString('ssl:p4.example.com:1666, surya, Project_Main'))
      .toEqual({ port: 'ssl:p4.example.com:1666', user: 'surya', client: 'Project_Main' });
    expect(parseP4vConnectionString('ssl:p4.example.com:1666, surya'))
      .toEqual({ port: 'ssl:p4.example.com:1666', user: 'surya' });
  });

  it('prefers a complete P4V connection over an earlier partial one', () => {
    const xml = [
      '<PropertyList varName="Connection">',
      '  <String varName="LastConnection">ssl:server:1666, surya</String>',
      '  <StringList varName="RecentConnections">',
      '    <String>ssl:server:1666, surya, Project_Main</String>',
      '  </StringList>',
      '</PropertyList>',
    ].join('\n');
    expect(parseP4vApplicationSettingsXml(xml)).toEqual({ port: 'ssl:server:1666', user: 'surya', client: 'Project_Main' });
    expect(parseP4vApplicationSettingsXml('<String varName="LastConnection">ssl:server:1666</String>'))
      .toEqual({ port: 'ssl:server:1666' });
  });

  it('reads the first P4V connection map entry', () => {
    const xml = [
      '<ConnectionMapList varName="connectionmaplist">',
      '  <ConnectionMap><User>surya</User><P4Port>ssl:p4.example.com:1666</P4Port></ConnectionMap>',
      '  <ConnectionMap><User>other</User><P4Port>ssl:other.example.com:1666</P4Port></ConnectionMap>',
      '</ConnectionMapList>',
    ].join('\n');
    expect(parseP4vConnectionMapXml(xml)).toEqual({ port: 'ssl:p4.example.com:1666', user: 'surya' });
  });

  it('fills only missing values and reports what was contributed', () => {
    expect(fillMissing({ port: 'ssl:primary:1666' }, { port: 'ssl:fallback:1666', user: 'surya' }))
      .toEqual({ settings: { port: 'ssl:primary:1666', user: 'surya' }, contributed: ['user'] });
  });
});

describe('resolveConnection', () => {
  it('resolves through p4 set in the working directory, ignoring the configured connection', async () => {
    const recorder = recordingExecutor(replayExecutor([corpus.get('settings')!]));
    const resolved = await Effect.runPromise(resolveConnection({ sources: ['p4'] }).pipe(
      Effect.provide(Layer.merge(recorder.layer, configLayer({ cwd: 'C:/ws', connection: { port: 'ssl:other:1666' } }))),
    ));
    expect(resolved).toEqual({
      connection: { port: '<LOCAL_PORT>', user: 'p4ts-e2e', client: 'p4ts_e2e_client', charset: 'utf8' },
      sources: { port: 'p4', user: 'p4', client: 'p4', charset: 'p4' },
    });
    expect(recorder.invocations[0]?.cwd).toBe('C:/ws');
    expect(recorder.invocations[0]?.args).not.toContain('ssl:other:1666');
  });
});
