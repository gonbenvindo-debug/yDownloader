# yDownloader

Extensão para escolher uma resolução e descarregar vídeos do YouTube. A extração, a transferência e a união de áudio e vídeo são feitas no browser; não é necessário iniciar ou hospedar um servidor.

## Instalação

1. Descarrega e extrai o ZIP do repositório.
2. Abre `chrome://extensions` ou `brave://extensions` e ativa o modo de programador.
3. Escolhe **Carregar expandida** e seleciona a pasta `extension`.

Não é necessário instalar Node.js para usar a extensão já compilada incluída nesta pasta.

## Como funciona

- A extensão obtém os formatos e os links dos streams diretamente do YouTube com `youtubei.js`, usando clientes alternativos do YouTube quando necessário.
- Formatos que já incluem áudio e vídeo são guardados pelo gestor de downloads do browser.
- Quando o YouTube fornece áudio e vídeo separados, a extensão abre uma página local. Ao escolher o ficheiro de destino, o Mediabunny une os streams e grava o resultado diretamente no disco, sem manter o vídeo inteiro em memória.
- O QuickJS/WebAssembly executa o pequeno código de assinatura do player dentro de um interpretador isolado. O código dinâmico não é executado no contexto da extensão.

## Compilar a extensão

Requer Node.js 22 ou superior.

```sh
npm install
npm run build
```

Depois, carrega novamente a pasta `extension` em `chrome://extensions` ou `brave://extensions`.

## Limitações

- O browser tem de conseguir ler os codecs e o formato apresentados pelo YouTube. A extensão oculta formatos DRM ou que não consiga unir.
- Vídeos privados, indisponíveis ou que exijam autenticação podem não fornecer streams à extensão.
- O YouTube nem sempre fornece links de mídia para todas as resoluções. A extensão só mostra formatos com streams utilizáveis; em alguns vídeos, isso pode limitar a qualidade máxima disponível.
- O browser pede confirmação do ficheiro de destino nos formatos que precisam de unir áudio e vídeo.
