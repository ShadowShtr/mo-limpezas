# Mapa e GPS operacional

## Objetivo

O dashboard `/dashboard/mapa` mostra:

- locais dos servicos agendados;
- pontos GPS registados pelas colaboradoras no clock-in e clock-out;
- rotas por equipa, quando ha pelo menos 2 servicos com coordenadas.

## Mapa base

O mapa abre centrado em Lisboa:

- latitude: `38.7223`
- longitude: `-9.1393`
- zoom: `12`

O mapa base usa tiles raster CARTO/OSM por defeito para evitar ecra cinza caso o estilo Mapbox falhe.

O token Mapbox continua configurado em `NEXT_PUBLIC_MAPBOX_TOKEN` para chamadas Mapbox, como rotas/directions.

## Variaveis Vercel

Em Production, confirmar:

- `NEXT_PUBLIC_MAPBOX_TOKEN`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Se o mapa aparecer cinza, verificar primeiro:

1. deploy ativo em Production;
2. `NEXT_PUBLIC_MAPBOX_TOKEN` preenchido no Vercel;
3. permissao de rede para tiles CARTO/OSM;
4. cache do browser (`Ctrl+F5`).

## Clock-in e clock-out

Endpoint: `/api/app/timesheet`

### Clock-in

Metodo: `POST`

Payload:

```json
{
  "service_id": "uuid",
  "lat": 38.7223,
  "lng": -9.1393
}
```

Regras:

- utilizador precisa estar autenticado;
- GPS e obrigatorio;
- colaboradora precisa pertencer a equipa do servico ou estar como reforco;
- grava `clock_in_lat` e `clock_in_lng`;
- calcula distancia ao local do servico quando o local tem coordenadas;
- marca `location_warning` se passar do raio configurado em `company_settings.gps_radius_meters`;
- atualiza o servico para `em_curso` se ainda nao tiver `actual_start`.

### Clock-out

Metodo: `PATCH`

Payload:

```json
{
  "service_id": "uuid",
  "lat": 38.7223,
  "lng": -9.1393
}
```

Regras:

- GPS e obrigatorio;
- encontra timesheet aberto da colaboradora;
- grava `clock_out_lat` e `clock_out_lng`;
- calcula `duration_minutes`;
- se nao houver mais timesheets abertos no servico, atualiza o servico para `concluido`.

## Dados do mapa

Server action: `getMapServices(date)`

Retorna:

- `services`: servicos com coordenadas do local;
- `teams`: equipas ativas;
- `clockPoints`: pontos GPS de entrada/saida gravados em `timesheets`.

Cada `clockPoint` inclui:

- colaboradora;
- tipo `in` ou `out`;
- hora;
- coordenadas;
- servico/local;
- equipa;
- `location_warning`.

## Marcadores

No mapa:

- marcador do servico: pin com cor da equipa e borda do estado;
- `E`: entrada da colaboradora;
- `S`: saida da colaboradora;
- borda amarela: ponto fora do raio GPS configurado.

## Atualizacao em tempo real

O dashboard subscreve alteracoes Supabase na tabela `timesheets`.

Quando uma colaboradora bate ponto:

1. Supabase recebe insert/update em `timesheets`;
2. mapa chama novamente `getMapServices(date)`;
3. novos pontos GPS aparecem no mapa.

## Tabelas envolvidas

- `services`
- `locations`
- `teams`
- `team_members`
- `service_reinforcements`
- `timesheets`
- `company_settings`

## Commits relacionados

- `74846e1` - fallback inicial do mapa;
- `688fbe6` - ocultar token em erros;
- `365f3ea` - pontos GPS das colaboradoras no mapa;
- `c2bd77a` - centro inicial em Lisboa e fallback CARTO/OSM.
