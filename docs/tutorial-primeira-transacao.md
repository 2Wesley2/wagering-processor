# Tutorial: a primeira transação

Neste tutorial você cria uma wallet, aposta, recebe um prêmio, repete uma requisição, vê uma rejeição
e confere que o saldo bate com o ledger. Leva poucos minutos e usa só a API pelo nginx.

**Antes de começar:** a stack precisa estar no ar. Siga o README até
[Subir e verificar o serviço](../README.md#subir-e-verificar-o-serviço).

Cada passo tem duas versões: **PowerShell 7** e **bash**. Escolha uma e use só ela do começo ao fim,
na mesma janela, porque os passos guardam valores em variáveis. As duas foram executadas em
2026-11-14 (o bash no Git Bash do Windows); as saídas abaixo são as reais, só com os ids daquela
execução.

## Passo 1: criar a wallet

Crie uma wallet com 100,00 BRL para um player novo.

```powershell
$api = 'http://localhost:8080'
$player = [guid]::NewGuid().ToString()
$wallet = Invoke-RestMethod -Method Post -Uri "$api/wallets" -ContentType 'application/json' -Body (@{ playerId = $player; initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json)
$wallet | ConvertTo-Json -Compress
```

```bash
API=http://localhost:8080
PLAYER=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed -E 's/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/\1-\2-4\3-8\4-\5/')
WALLET_JSON=$(curl -s -X POST "$API/wallets" -H 'content-type: application/json' -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
WALLET=$(echo "$WALLET_JSON" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "$WALLET_JSON"
```

A API responde 201 com a wallet na versão 1:

```json
{"id":"01a1d84a-5146-74dc-933c-ebb16c2422bb","playerId":"07cec02d-c2eb-4210-92ca-3dc1dc774116","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

O saldo inicial já virou um lançamento de crédito no ledger. Você vai vê-lo no passo 6.

## Passo 2: apostar 30,00

Primeiro, defina uma função que monta e envia uma transação. Toda transação precisa de uma
`Idempotency-Key`; aqui ela é `provider-a:` seguido do id externo da operação.

```powershell
$round = "round-$(Get-Random)"
function Send-Transaction($externalId, $kind, $amount, $reference) {
  $body = @{ providerId = 'provider-a'; externalTransactionId = $externalId; playerId = $player; walletId = $wallet.id; roundId = $round; gameId = 'game-1'; kind = $kind; money = @{ amount = $amount; currency = 'BRL' } }
  if ($reference) { $body.referenceExternalTransactionId = $reference }
  $response = Invoke-RestMethod -Method Post -Uri "$api/wagering/transactions" -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = "provider-a:$externalId" } -Body ($body | ConvertTo-Json) -SkipHttpErrorCheck -StatusCodeVariable status
  Write-Host "HTTP $status"
  $response
}
$betId = "bet-$(Get-Random)"
Send-Transaction $betId 'BET' '30.00' | ConvertTo-Json -Compress -Depth 5
```

```bash
ROUND="round-$RANDOM"
send_transaction() { # id externo, tipo, valor e, opcionalmente, a referência
  REF=${4:+",\"referenceExternalTransactionId\":\"$4\""}
  curl -s -w '\nHTTP %{http_code}\n' -X POST "$API/wagering/transactions" -H 'content-type: application/json' -H "Idempotency-Key: provider-a:$1" -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"$ROUND\",\"gameId\":\"game-1\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$REF}"
}
BET="bet-$RANDOM"
send_transaction "$BET" BET 30.00
```

A aposta é aplicada (200) e o saldo cai para 70,00:

```json
{"transactionId":"01a1d84a-59de-7393-8539-139a1191b5db","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

## Passo 3: receber um prêmio de 50,00

Envie um WIN que aponta para a aposta do passo 2.

```powershell
Send-Transaction "win-$(Get-Random)" 'WIN' '50.00' $betId | ConvertTo-Json -Compress -Depth 5
```

```bash
send_transaction "win-$RANDOM" WIN 50.00 "$BET"
```

O prêmio é aplicado (200) e o saldo sobe para 120,00:

```json
{"transactionId":"01a1d84a-621d-7000-86ad-7a5a148bbc87","status":"PROCESSED","balance":{"amount":"120.00","currency":"BRL"},"idempotentReplay":false}
```

## Passo 4: repetir a aposta

Envie de novo a aposta do passo 2, com a mesma `Idempotency-Key` e o mesmo corpo. É o que um
provedor faz quando não sabe se a primeira requisição chegou.

```powershell
Send-Transaction $betId 'BET' '30.00' | ConvertTo-Json -Compress -Depth 5
```

```bash
send_transaction "$BET" BET 30.00
```

A resposta é a mesma da primeira vez, inclusive o saldo de 70,00, agora com
`idempotentReplay: true`. Nada foi debitado de novo: o saldo da wallet continua 120,00.

```json
{"transactionId":"01a1d84a-59de-7393-8539-139a1191b5db","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":true}
```

## Passo 5: ver uma rejeição

Tente apostar 500,00, mais do que o saldo.

```powershell
Send-Transaction "big-$(Get-Random)" 'BET' '500.00' | ConvertTo-Json -Compress -Depth 5
```

```bash
send_transaction "big-$RANDOM" BET 500.00
```

A API responde 422 com o código `INSUFFICIENT_FUNDS`. A rejeição fica gravada, mas o saldo continua
120,00:

```json
{"type":"urn:wagering:error:INSUFFICIENT_FUNDS","title":"INSUFFICIENT_FUNDS","status":422,"code":"INSUFFICIENT_FUNDS","detail":"transação rejeitada por regra de negócio: INSUFFICIENT_FUNDS","retryable":false,"correlationId":"01a1d84a-727e-743a-87ce-25b74b5beb46","transaction":{"transactionId":"01a1d84a-728e-70a1-98fb-5d6f6ff2831e","status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS","balance":{"amount":"120.00","currency":"BRL"}},"idempotentReplay":false}
```

## Passo 6: conferir

Consulte a aposta, o ledger e a reconciliação da wallet.

```powershell
Invoke-RestMethod -Uri "$api/providers/provider-a/wagering/transactions/$betId" | Select-Object status, balance, walletVersion, initialStatus | ConvertTo-Json -Compress
(Invoke-RestMethod -Uri "$api/wallets/$($wallet.id)/ledger").entries | ForEach-Object { "$($_.walletVersion) $($_.direction) $($_.money.amount) $($_.balanceBefore.amount) -> $($_.balanceAfter.amount)" }
Invoke-RestMethod -Method Post -Uri "$api/wallets/$($wallet.id)/reconciliation" | ConvertTo-Json -Compress -Depth 5
```

```bash
curl -s "$API/providers/provider-a/wagering/transactions/$BET"; echo
curl -s "$API/wallets/$WALLET/ledger"; echo
curl -s -X POST "$API/wallets/$WALLET/reconciliation"; echo
```

A aposta mostra o saldo da decisão (70,00 na versão 2), não o saldo atual. O ledger tem três
lançamentos, um por operação que mexeu no saldo; a repetição e a rejeição não aparecem:

```text
1 CREDIT 100.00 0.00 -> 100.00
2 DEBIT 30.00 100.00 -> 70.00
3 CREDIT 50.00 70.00 -> 120.00
```

A reconciliação confirma que o saldo gravado é a soma do ledger:

```json
{"walletId":"01a1d84a-5146-74dc-933c-ebb16c2422bb","storedBalance":{"amount":"120.00","currency":"BRL"},"calculatedBalance":{"amount":"120.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":3,"issues":[]}
```

## O que você viu

- **Idempotência:** a mesma `Idempotency-Key` com o mesmo corpo devolve a resposta original, sem
  novo efeito (passo 4). Veja o [glossário](glossario.md) e a
  [referência da API](referencia/api-http.md#post-wageringtransactions).
- **Saldo e ledger:** cada operação que mexe no saldo gera um lançamento, e o saldo é sempre a soma
  deles (passos 1 a 3 e 6). Rejeições não geram lançamento (passo 5).
- **Saldo da decisão:** respostas e consultas mostram o saldo do momento da decisão, não o atual
  (passos 4 e 6).
- **Por que funciona assim:** o lock por wallet, a idempotência no banco e as invariantes do schema
  estão no ARCHITECTURE,
  [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3)
  e [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2).

A wallet criada aqui fica no banco; nada é apagado. Para recomeçar do zero, veja
[Limpeza completa](../README.md#limpeza-completa-irreversível) no README.
