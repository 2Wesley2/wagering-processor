# Quickstart: validar a F3

Na raiz do projeto, no host (PowerShell ou bash), nesta ordem:

```bash
docker compose run --rm --build tests bun scripts/test-all.ts --phase F3
docker compose up --build -d
docker compose run --rm --no-deps tests bun run test:smoke --level full
```

Esperado:

1. `--phase F3` sai com 0 e o meta-check não lista nenhum ID obrigatório até a F3 fora de PASS
   (IT-07b, IT-10a, IT-11, IT-12, IT-13, IT-18, CT-01h, CT-02h, CT-03, CT-04h, CT-09, CT-10, CT-12,
   CT-13, além dos de F0–F2).
2. A stack sobe sem migration nova (`migrate` executa `[]`).
3. O smoke `full` (V2b) sai com 0: cria uma wallet própria, BET, WIN referenciando a BET, replay da
   BET com o mesmo corpo, as duas consultas e reconciliação consistente, com ≥ 2 `X-Instance-Id`.

O smoke grava uma wallet de demonstração por execução e nunca apaga dados.
