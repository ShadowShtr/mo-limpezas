# Riscos Operacionais — Mó Limpezas

> Documento vivo. Última revisão: 2026-06-18.  
> Gravidades: **P0** = operação parada · **P1** = perda/erro de dados · **P2** = lentidão/cache/usabilidade

---

## P0 — Operação parada

| # | Área | Problema | Sintoma |
|--:|------|----------|---------|
| 5 | Conexão/API | Supabase lento ou indisponível | Login, calendário, pontos e clientes demoram ou falham |
| 7 | Deploy | Variável de ambiente errada em produção | Sistema abre, mas login, mapas, Supabase ou uploads param |
| 11 | Segurança/RLS | Policy permissiva demais | Funcionária vê dados de outra colaboradora/cliente |
| 30 | Base/Disco | Tabelas crescem sem limpeza (pontos, logs, notificações) | Banco pesado/caro/lento; pode ficar read-only |

**Outros P0 silenciosos**
- Cálculo errado da folha por faltas/férias mal ligadas
- Migration aplicada diretamente em produção sem teste
- Ausência de backup testado e verificado

---

## P1 — Perda ou erro de dados

| # | Área | Problema | Sintoma |
|--:|------|----------|---------|
| 1 | Conexão | Ponto sem internet no cliente | Botão gira mas nada grava no Supabase |
| 2 | Conexão | Internet cai durante envio do ponto | Funcionária acha que marcou; admin não vê o registo |
| 3 | Conexão | Pedido reenviado várias vezes após falha | Mesmo ponto aparece duplicado |
| 6 | Vercel | Rota API demora demais → 504 | Exportar folha/pagamentos trava com Gateway Timeout |
| 8 | Auth | Sessão expirada no turno | App abre tela vazia ou erro ao bater ponto |
| 9 | Auth/RLS | `empresa_id` ou `role` nulo/errado | Funcionária entra mas não vê escala nem consegue marcar |
| 10 | Segurança/RLS | Policy bloqueia demais | Admin vê listas vazias mesmo existindo registos |
| 12 | Dados | Clique duplo no botão de ponto | Dois check-ins ou check-outs para o mesmo serviço |
| 13 | Dados | Entrada sem saída anterior | Funcionária não consegue marcar corretamente no dia seguinte |
| 14 | Dados | Edição simultânea por dois admins | Uma alteração apaga a outra (last-write-wins) |
| 15 | Dados | Cliente/local apagado com serviços futuros | Calendário mostra serviço quebrado, sem morada |
| 16 | Calendário | Fuso horário Europe/Lisbon ou horário de verão | Serviço aparece no dia anterior/seguinte; ponto com 1h de desvio |
| 17 | Calendário | Serviço recorrente mal gerado | Limpeza semanal duplica, salta semanas ou cria dias errados |
| 18 | GPS | Funcionária nega permissão de localização | App não valida presença e bloqueia ponto |
| 19 | GPS | GPS impreciso em edifício/garagem | Funcionária no local, sistema acusa distância fora do raio |

**Outros P1 silenciosos**
- Upload de fotos/comprovativos acima do limite do Supabase Storage
- Nomes de ficheiro inválidos (caracteres especiais, espaços, Unicode)
- Colaboradora com dois dispositivos abertos ao mesmo tempo
- Conta partilhada entre funcionárias (rastreabilidade zero)
- Falta de logs claros para distinguir erro de telemóvel, Supabase, Vercel, GPS ou RLS

---

## P2 — Lentidão, cache e usabilidade

| # | Área | Problema | Sintoma |
|--:|------|----------|---------|
| 4 | Conexão | Wi-Fi fraco troca para 4G a meio da operação | Calendário carrega a metade; ponto fica pendente |
| 20 | GPS | Localização antiga presa em cache | App usa coordenada anterior; marca funcionária no sítio errado |
| 21 | GPS/Bateria | Modo poupança de bateria limita localização | Ponto demora muito ou falha por timeout de localização |
| 22 | Mapas | Token Mapbox apagado/vencido/sem escopo | Mapa fica branco, erro 401/403 |
| 23 | PWA/Cache | Service worker mantém versão antiga | Correção aplicada mas telemóvel continua com erro antigo |
| 24 | PWA/Cache | Dados antigos do calendário em cache | Funcionária vê serviço cancelado como se existisse |
| 25 | PWA/LocalStorage | Cache/localStorage corrompido | App abre tela branca, loop de login ou utilizador errado |
| 26 | Armazenamento | Navegador sem espaço ou limpa dados | Sessão, cache e dados offline desaparecem; PWA "zerado" |
| 27 | Performance DB | Filtros do calendário sem índices | Calendário demora 10–30 s ao crescer em clientes/serviços |
| 28 | Performance DB | Dashboard com consultas em excesso | Admin abre painel e dispara muitas queries em simultâneo |
| 29 | Realtime | Canais/conexões Supabase Realtime a mais | Dashboard deixa de atualizar; WebSocket cai |

---

## Plano de ação recomendado

1. **Offline-first básico** — guardar ponto em `localStorage`/IndexedDB e sincronizar quando voltar a rede (resolve #1, #2, #3, #4)
2. **Idempotência no endpoint de ponto** — chave única `(colaboradora, serviço, tipo, janela 5 min)` no Supabase para evitar duplicados (resolve #3, #12)
3. **Renovação automática de sessão** — refresh token silencioso antes de expirar; fallback para re-login suave (resolve #8)
4. **Auditoria de RLS** — script que testa cada role contra cada tabela com dados reais de staging (resolve #9, #10, #11)
5. **Soft-delete em clientes e serviços** — nunca apagar; arquivar com `deleted_at` (resolve #15)
6. **Datas sempre em UTC no DB** — converter para `Europe/Lisbon` só na UI (resolve #16)
7. **Índices no calendário** — `(empresa_id, data)` em `services`; `(colaboradora_id, data)` em `time_records` (resolve #27)
8. **GPS gracioso** — fallback manual com confirmação quando GPS falha ou é negado (resolve #18, #19, #21)
9. **Política de retenção** — arquivar pontos/logs com > 12 meses para tabela histórica; notificação de crescimento (resolve #30)
10. **Runbook de incidentes** — checklist para distinguir falha de telemóvel, Supabase, Vercel, GPS ou RLS

---

*Issues abertas no GitHub com base neste documento: ver labels `p0`, `p1`, `p2`.*
