# ATLAS MEMORY

Repositório canônico da camada de memória persistente do ecossistema ATLAS / MATRIX ATTUAL / Grupo Lira de Comunicação.

## Responsabilidades

- Knowledge / contexto persistente
- Decisions estruturadas
- Events / timeline
- Referências documentais do Google Drive
- Edge Function compatível com o ATLAS Gateway
- Migrations e testes da base Supabase

## Projeto Supabase

- Organização: Matrix Attual
- Projeto: atlas-memory
- Project Ref: `quypmwyqccdbjfbgimfw`

## Regras

- Nenhum segredo, senha, token ou chave deve ser commitado neste repositório.
- Credenciais ficam em secret manager autorizado.
- Google Drive guarda documentos/evidências; a MEMORY guarda estado estruturado e referências.
- Mudanças de schema devem passar por migration versionada.
- Decisions não devem ser simuladas por registros de Knowledge; são uma coleção própria.
- Migração deve preservar histórico e evidência, sem apagar a origem.

## Estado inicial

Criado em 24/09/2026 para retirar a ATLAS MEMORY de projetos de clientes e estabelecer infraestrutura dedicada do Grupo Lira.
