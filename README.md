# yDownloader

Downloader mínimo em Node.js para vídeos do YouTube. Inclui o executável autónomo do yt-dlp, que traz o seu próprio runtime Python; não é preciso instalar Python à parte. O FFmpeg tem de estar instalado e disponível no `PATH`.

Requer Node.js 22 ou superior. Inicia a app na pasta deste projeto:

```powershell
npm start
```

Se o FFmpeg não estiver no `PATH`, indica o caminho antes de iniciar:

```powershell
$env:FFMPEG_PATH = 'C:\caminho\para\ffmpeg.exe'
npm start
```

Há apenas dois endpoints:

```http
GET /resolutions?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ
```

Resposta:

```json
{"resolutions":[144,240,360,480,720,1080,1440,2160]}
```

```http
POST /download
Content-Type: application/json

{"url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ","resolution":1080}
```

O segundo endpoint envia o MP4 fragmentado diretamente ao cliente enquanto o FFmpeg junta vídeo e áudio, sem criar primeiro um ficheiro temporário. Para verificar a API, inicia o servidor e corre `npm test` noutro terminal.

## Extensão Chrome

Com o servidor a correr, abre `chrome://extensions` (ou `brave://extensions`), ativa o modo de programador e escolhe **Carregar expandida**. Seleciona a pasta `extension` deste projeto e atualiza a página do YouTube. Se alterares os ficheiros da extensão, carrega também em **Atualizar** na página das extensões. O botão de download lê as opções do menu Qualidade do player; ao selecionares uma, o card fecha e a transferência aparece no gestor do Chrome ou Brave com bytes recebidos em fluxo. A extensão pede permissão para gerir downloads e para aceder à API local em `127.0.0.1`.
