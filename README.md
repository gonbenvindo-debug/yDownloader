# yDownloader

Extensão para escolher uma resolução e descarregar vídeos do YouTube. A extração, a transferência e a união de áudio e vídeo são feitas no browser; não é necessário iniciar ou hospedar um servidor.

## Instalação

1. Descarrega e extrai o ZIP do repositório.
2. Abre `chrome://extensions` ou `brave://extensions` e ativa o modo de programador.
3. Escolhe **Carregar expandida** e seleciona a pasta `extension`.

Não é necessário instalar Node.js para usar a extensão já compilada incluída nesta pasta.

## Como funciona

- A arquitetura SABR foi estudada a partir de [avi12/youtube-downloader](https://github.com/avi12/youtube-downloader), que documenta captura da sessão do player e processamento offscreen no Chrome. Aqui a implementação é menor: mantém o percurso direto existente e usa `googlevideo` para uma alternativa SABR local, sem copiar o código desse projeto.
- As resoluções são lidas do player ativo: `getAvailableQualityData`, `getAvailableQualityLevels` e os formatos de `getPlayerResponse`/`ytInitialPlayerResponse`. Esta leitura é local e não faz pedidos adicionais ao YouTube. Os dados são atualizados ao mudar de vídeo.
- Os mesmos formatos da página são reutilizados para transferências diretas e SABR. A biblioteca `youtubei.js` só é usada durante o download quando é necessário decifrar assinaturas ou procurar streams que o player não expôs.
- Quando o YouTube não expõe URLs diretas, a extensão pode reutilizar a sessão SABR criada pelo player ativo. `googlevideo` lê o protocolo e transfere os segmentos numa página offscreen do Chrome; os ficheiros temporários ficam no armazenamento privado do browser.
- Formatos que já incluem áudio e vídeo são guardados pelo gestor de downloads do browser.
- Quando o YouTube fornece áudio e vídeo separados, a extensão abre uma página local. Ao escolher o ficheiro de destino, o Mediabunny une os streams e grava o resultado diretamente no disco, sem manter o vídeo inteiro em memória. A mesma união é usada para segmentos SABR.
- O QuickJS/WebAssembly executa o pequeno código de assinatura do player dentro de um interpretador isolado. O código dinâmico não é executado no contexto da extensão.

## Compilar a extensão

Requer Node.js 22 ou superior.

```sh
npm install
npm run build
```

O build também atualiza a versão descompactada na pasta fixa `../../outputs/yDownloader`. Depois, recarrega a extensão em `chrome://extensions` ou `brave://extensions` e atualiza a página do vídeo para ativar os scripts novos.

## Limitações

- O browser tem de conseguir ler os codecs e o formato apresentados pelo YouTube. A extensão oculta formatos DRM ou que não consiga unir.
- Vídeos privados, indisponíveis ou que exijam autenticação podem não fornecer streams à extensão.
- O seletor pode expor uma resolução antes dos dados de transferência estarem disponíveis. Inicia a reprodução para obter a sessão de download do player.
- A opção SABR depende de o player ativo ter criado uma sessão válida no separador atual; inicia a reprodução antes de abrir o menu de download.
- O browser pede confirmação do ficheiro de destino nos formatos que precisam de unir áudio e vídeo.
