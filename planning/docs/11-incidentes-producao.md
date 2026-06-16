# Incidentes de Producao

## 2026-06-16 - Relatorios de avaria nao eram enviados

### Sintoma

Na app da colaboradora, o fluxo "Reportar avaria / dano" ficava sem completar o envio do ficheiro para o gestor.

### Causa

A policy de Storage criada na migration 022 validava `profiles.role = 'colaboradora'`, mas o schema real usa `profiles.role = 'colaborador'`.

Tambem havia restricao de MIME types no bucket `collaborator-documents`. Isso podia bloquear formatos comuns de telemovel, como HEIC/HEIF.

### Correcao

- `supabase/migrations/023_fix_collaborator_documents_upload.sql`
  - corrige a policy para `role = 'colaborador'`
  - remove restricoes de MIME no bucket
  - garante bucket privado
- `src/lib/collaborator-documents.ts`
  - centraliza path seguro de ficheiros
  - centraliza payload de notificacao aos gestores
- `src/__tests__/collaborator-documents.test.ts`
  - cobre role correto, path de storage, notificacoes e migration

### Validacao

- `npm test` passou: 255 testes
- `npm run build` passou
- Migration 023 aplicada no Supabase ligado
- Deploy Vercel de producao concluido

URL: https://mo-limpezas.vercel.app
