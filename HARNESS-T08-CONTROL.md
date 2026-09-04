# HARNESS-T08-STABILITY — branch de controlo

Branch descartável, criada a partir do master `157ef325` sem qualquer alteração
funcional, para responder a uma pergunta única:

> o `t08-cli.test.ts` também estoura o teto de 60s no CI quando o código é o do
> master, no mesmo ambiente e na mesma janela horária?

Se sim, o timeout é do harness e não da stack financeira, e a correção pertence
a uma frente própria em vez de contaminar a #150/#151.

Apagar depois de lida a resposta.
