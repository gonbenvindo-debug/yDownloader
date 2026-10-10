# yDownloader

Extensão para escolher uma resolução e descarregar vídeos do YouTube. A extração, a transferência e a união de áudio e vídeo são feitas no browser; não é necessário iniciar ou hospedar um servidor.

## Instalação

1. Descarrega e extrai o ZIP do repositório.
2. Abre `chrome://extensions` ou `brave://extensions` e ativa o modo de programador.
3. Escolhe **Carregar expandida** e seleciona a pasta `extension`.

Não é necessário instalar Node.js para usar a extensão já compilada incluída nesta pasta.

## Como funciona

- A arquitetura SABR foi estudada a partir de [avi12/youtube-downloader](https://github.com/avi12/youtube-downloader), que documenta captura da sessão do player e processamento offscreen no Chrome. Aqui a implementação é menor: mantém o percurso direto existente e usa `googlevideo` para uma alternativa SABR local, sem copiar o código desse projeto.
- As resoluções são lidas do player ativo e do JSON dos scripts da página. Respostas parciais de `getPlayerResponse` são completadas com `ytInitialPlayerResponse`. Se estes dados estiverem incompletos ou pertencerem ao vídeo anterior, a extensão lê o HTML de `/watch?v=...` no próprio YouTube, com a sessão do utilizador. Não há servidor intermédio.
- Tal como no sistema original com yt-dlp, o menu lista todas as resoluções de vídeo sem DRM antes de escolher os streams de áudio. Dados reduzidos, codecs ausentes e identificadores numéricos em texto não fazem desaparecer a lista. O áudio e o contentor são escolhidos no download.
- Os mesmos formatos da página são reutilizados para transferências diretas e SABR. A biblioteca `youtubei.js` só é usada durante o download quando é necessário decifrar assinaturas ou procurar streams que o player não expôs.
- Quando o YouTube não expõe URLs diretas, a extensão pode reutilizar a sessão SABR criada pelo player ativo. `googlevideo` lê o protocolo e transfere os segmentos numa página offscreen do Chrome; os ficheiros temporários ficam no armazenamento privado do browser.
- Quando um URL direto exige decifrar uma assinatura, uma sessão SABR válida também pode ser usada para evitar outro pedido de extração à API.
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

## Verificação

`npm test` verifica o leitor, a ponte MAIN/isolated, a validação e cancelamento de streams, tarefas após recarregar a página e o worker compilado. `npm run test:youtube` lê três páginas públicas e compara as resoluções do worker com os formatos do YouTube. `npm run test:chrome` abre um perfil isolado do Chrome, carrega a extensão, transfere e une os streams, volta a abrir a página, guarda o ficheiro e valida resolução, duração, codecs e reprodução no início, meio e fim. A transferência 4K verificada foi [Big Buck Bunny 4K](https://www.youtube.com/watch?v=aqz-KE-bpKQ); o relatório local regista duração, codecs, pacotes e SHA-256.

O teste do Chrome usa `../../outputs/test-4k` para guardar o ficheiro e o relatório. Pode receber um vídeo público e resolução alternativos através de `TEST_VIDEO_URL`, `TEST_RESOLUTION` e `TEST_OUTPUT_DIR`. O teste substitui apenas o seletor nativo de destino por um ficheiro temporário do próprio Chrome; a transferência e a união passam pela implementação real da extensão.

## Limitações

- A extensão oculta formatos DRM. Uma resolução pode ser mostrada antes de os dados de áudio e codecs necessários à transferência estarem disponíveis; a compatibilidade é verificada ao preparar o download.
- Vídeos privados, indisponíveis ou que exijam autenticação podem não fornecer streams à extensão.
- O seletor pode expor uma resolução antes dos dados de transferência estarem disponíveis. Inicia a reprodução para obter a sessão de download do player.
- A opção SABR depende de o player ativo ter criado uma sessão válida no separador atual; inicia a reprodução antes de abrir o menu de download.
- O browser pede confirmação do ficheiro de destino nos formatos que precisam de unir áudio e vídeo.
