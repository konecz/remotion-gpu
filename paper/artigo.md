# Exportar vídeos do Remotion na GPU: render em camadas, medido contra o Chrome

**Pedro Henrique Lahr** ([ORCID 0009-0001-2206-4852](https://orcid.org/0009-0001-2206-4852)) · Konecz · outubro de 2026 · Remotion 4.0.536 · [English](paper.md)

## Resumo

O Remotion transforma composições React em vídeo capturando cada quadro de um Chrome headless. Quando a composição tem vídeo gravado embutido, a maior parte da CPU vai para decodificar esse vídeo e capturar os quadros, e não para o React. Descrevemos o `remotion-gpu`, uma ferramenta aberta com três caminhos: P1 (o `<Video>` do próprio Remotion com NVENC), P2 (render em camadas: o enquadramento escrito em React vira um plano quadro a quadro, executado na GPU pelo ffmpeg com Vulkan Video, libplacebo e NVENC, enquanto o Chrome desenha só os gráficos) e P3 (P2 pulando quadros de gráficos repetidos). Num vídeo de produção de 75 s, o P3 gastou 112 s de CPU (N=4) contra 460 s do P1 (N=1); a saída em camadas ficou com SSIM médio de 0,978 contra o P1 (N=1). Cada número vem com o número de rodadas e a carga da máquina; o benchmark entre tipos de vídeo é um piloto (N=1, 4 s). A contribuição é de sistemas e medição, não um algoritmo novo. Também relatamos o que não funcionou.

## 1. Introdução

Vídeo feito por código (Remotion, HyperFrames e ferramentas parecidas) roda um navegador por quadro. É flexível e caro. Num servidor que também hospeda sites em produção, a CPU é o recurso escasso; uma GPU grande muitas vezes fica parada.

A pergunta: **quanta CPU uma exportação do Remotion devolve quando a decodificação, a composição e a codificação vão para uma GPU NVIDIA, e a que custo de fidelidade visual?**

O que fizemos:

| # | Item | Seção |
|---|---|---|
| 1 | Medimos para onde vai a CPU num render do Remotion com vídeo embutido | 5.1 |
| 2 | Medimos, passo a passo, o caminho de GPU do próprio Remotion (P1) | 5.2 |
| 3 | Construímos um render em camadas (P2) guiado por um plano compilado do código de enquadramento em React | 4 |
| 4 | Igualamos a saída à do Chrome (espaço de mistura, escolha do quadro de origem) e medimos o SSIM contra o piso de ruído do codificador | 5.4 |
| 5 | Acrescentamos o dedup de quadros de gráficos pelo estado do DOM (P3) | 5.5 |
| 6 | Escrevemos um harness de benchmark aberto e rodamos um piloto | 5.6 |
| 7 | Registramos as abordagens que falharam | 6 |

## 2. Trabalhos relacionados

Uma revisão feita em 2026-10-29 abriu e leu 65 fontes (documentação, código, artigos, patentes). **Não encontramos nenhum trabalho revisado por pares sobre render web-to-video com navegador headless**, nem medição publicada de CPU por etapa no Remotion com vídeo embutido.

### 2.1 O que não é novo

| Ideia | Trabalho anterior |
|---|---|
| Decodificar vídeo dentro do Chrome e capturar quadros é o gargalo | Artigo técnico do HyperFrames («We don't let Chrome decode and schedule video») [14]; motor da Replit [15]; página de performance do Remotion [1]; PR #12109 do Remotion (captura mais rápida) [5]; issue #4364 do Remotion [4] |
| `<Video>` do `@remotion/media` + NVENC | Recomendação e recurso oficiais [1][2][9] |
| Pular quadros repetidos | PR #1549 do HyperFrames (previsão pela linha do tempo do GSAP, ligado por padrão) [11] e PR #2248 (`hasDamage` do `beginFrame`) [12]; `mpdecimate` do ffmpeg [32]; Rendering Elimination no hardware da GPU [39][40]; o próprio compositor do Chrome [46] |
| Gráficos com alfa compostos sobre o vídeo fora do navegador | Compositor HDR em camadas do HyperFrames (CPU, geometria do DOM a cada quadro) [13]; CasparCG (ao vivo, mixer na GPU, tweens por comando) [25]; fonte de navegador do OBS [26]; OpenMontage #45 [21]; remotion-ffmpeg-skill [22]; scorsese #775 [23]; fluxo com ProRes 4444 do Remotion [7] |
| Animação como dado, executada por um motor | Lottie [34]; controladores do GStreamer [29]; Editly [19]; Shotstack [24]; Vidformer, V2V, Vega-Video [36][37][38]; motion vectorization, gMotion, MoVer, DataMagic [42][43][44][45] |
| Capturar só a área que mudou (dirty rects) | `Experimental.Clipper` do Remotion, removido em 2024 porque «it did not actually make the render faster, rather slower» [6]; dirty rects do `OnPaint` do CEF [27]; `hasDamage` do CDP [28] |

O trabalho mais próximo é o **HyperFrames**. O compositor HDR dele já separa os gráficos (PNG com alfa) do vídeo e mistura os dois fora do Chrome, mas lê a geometria do DOM vivo a cada quadro e mistura na CPU, em JavaScript; o número publicado é de tempo de parede («~12 min for 19 s», 4K HDR) [13]. O dedup dele desliga com vídeo embutido [11].

O método básico (screenshots de navegador headless em intervalo fixo, montados em vídeo) é coberto por uma patente concedida [47]; ela não fala em GPU, camadas nem quadros repetidos.

Outros trabalhos de contexto. A captura determinística com relógio virtual vem do timecut e do timesnap [17]; o WebVideoCreator [16] usa `beginFrame`; o Motion Canvas e o Revideo [18] exportam sequências de imagens. O render no navegador do Remotion [8] codifica pelo WebCodecs [33] e pelo Mediabunny [35] e não fala em GPU. Um editor no navegador cortou o tempo por quadro guardando o conteúdo rasterizado e reaplicando só a transformação afim e o alfa [20]: a mesma intuição das camadas, dentro do navegador e na CPU. O NVIDIA DeepStream desenha primitivas fixas sobre o vídeo na GPU [30]. O URL2Video [41] transforma uma página web em vídeo, mas estuda o design, não o custo do render.

### 2.2 O que parece novo (depois desta busca)

1. **React → plano → GPU, de ponta a ponta.** A função de enquadramento que a composição usa (mola, zoom lento, punch-in) é amostrada no Node antes do render, compactada em trechos de reta com erro ≤ 0,05 px e executada pelo ffmpeg na GPU, da decodificação à codificação. O Chrome nunca vê o vídeo gravado.
2. **Equivalência visual medida contra o Chrome.** Espaço de mistura (luz linear contra gama), escolha do quadro de origem (25 → 30 quadros/s), SSIM quadro a quadro contra o piso de ruído do próprio codificador.
3. **Os números**, com CPU do cgroup, número de rodadas e carga.
4. **Um harness de benchmark aberto** com CPU, parede, memória, uso da GPU e qualidade por célula.

### 2.3 Cobertura

● cobre, ◐ em parte, ○ não. Colunas: (a) CPU medida por etapa, (b) `<Video>`/NVENC, (c) camadas compostas fora do navegador, (d) quadros repetidos ou dano, (e) benchmark publicado com método.

| Trabalho | a | b | c | d | e |
|---|---|---|---|---|---|
| Documentação do Remotion [1][2][3] | ◐ | ● | ○ | ○ | ○ |
| PR #12109 do Remotion [5] | ◐ | ○ | ○ | ○ | ◐ |
| `Experimental.Clipper` do Remotion [6] | ○ | ○ | ○ | ◐ | ○ |
| Motor de captura do HyperFrames [10][11][12] | ◐ | ◐ | ○ | ● | ○ |
| Compositor HDR do HyperFrames [13] | ○ | ○ | ◐ | ○ | ○ |
| CasparCG [25] / OBS [26] | ○ | ○ | ◐ | ◐ | ○ |
| OpenMontage #45 [21] / remotion-ffmpeg-skill [22] | ◐ | ○ | ◐ | ○ | ○ |
| Benchmark da Shotstack [24] | ○ | ○ | ◐ | ○ | ◐ |
| Vidformer / V2V [36][37] | ○ | ○ | ◐ | ○ | ◐ |
| Rendering Elimination [39] | ○ | ○ | ○ | ◐ | ○ |
| **Este trabalho** | ● | ● | ● | ● (variante) | ● (piloto) |

## 3. Método

### 3.1 Ambiente

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 7 7700X, 16 threads, governador `performance` |
| RAM | 62 GB |
| GPU | NVIDIA GeForce RTX 5090, 32 GB, driver 595.99.02 |
| Sistema | Ubuntu 26.04.1 LTS, kernel 7.0.0 |
| Node | 24.22.0 |
| Remotion | 4.0.536, `chrome-headless-shell` 157 |
| ffmpeg | 8.0.1 (do sistema, com libplacebo, sem libvmaf); n7.1 dentro do Remotion |
| Carga de fundo | sites em produção, 5 máquinas virtuais de CI, outros agentes. Load de 1 min no início da rodada: mediana de 3,94 no piloto (máx. 7,53) e de 4,54 na rápida (máx. 7,57) |
| GPU compartilhada | um servidor de inferência de LLM residente (llama-server) ocupava ~21 GB de VRAM; ocioso na amostra antes de cada rodada |

Todas as medições foram feitas em 2026-10-29, nesta única máquina.

### 3.2 Métricas

| Métrica | Definição |
|---|---|
| **CPU** (principal) | `user_usec + system_usec` do `cpu.stat` do escopo do systemd do próprio render |
| CPU por segundo de vídeo | CPU ÷ duração do vídeo |
| Parede | relógio monotônico, do spawn ao fim |
| Memória | `memory.peak` do cgroup; pico de memória anônima amostrado a cada 0,5 s |
| GPU | `nvidia-smi dmon`: sm, enc, dec, VRAM. **Da placa inteira** |
| Qualidade | SSIM (média, pior quadro, 1º percentil) e PSNR em RGB; cada vídeo decodificado pela própria marcação de cor; quadros pareados pelo índice. VMAF indisponível |
| Piso de ruído | a referência recodificada pelo codificador do caminho, sem mudar mais nada, contra ela mesma |

**Por que a CPU do cgroup.** O recurso escasso é a CPU de que os outros serviços precisam. O Remotion abre processos do Chrome, um compositor e o ffmpeg; o cgroup conta todos os descendentes. Uma ferramenta anterior (`/usr/bin/time`) perdia os filhos do Chrome e contava menos da metade. Nenhum número aqui vem dela, exceto o primeiro teste de viabilidade (Tabela 1), em que o ffmpeg é um processo só.

### 3.3 Protocolo

| Passo | Detalhe |
|---|---|
| Contenção, igual para todos os caminhos | `systemd-run --user --scope -p CPUQuota=800% nice -n 19 ionice -c 3`: no máximo 8 das 16 threads |
| Aquecimento | uma passada por todas as células, descartada |
| Ordem | sorteada a cada repetição (Fisher–Yates, semente 20261029) |
| Espera pela máquina quieta | nenhum outro render; load de 1 min < 8; CPU ocupada < 35% em duas checagens seguidas. Se a espera estoura, a rodada roda e fica marcada |
| Experimentos de antes e depois | rodadas alternadas entre as variantes, porque a carga variava |
| Análise | mediana, IQR, intervalo de confiança da mediana por bootstrap percentil (10 000 reamostras, semente fixa). Com N=1 não há intervalo |

### 3.4 Janelas de medição

Números de janelas diferentes nunca são divididos um pelo outro.

| Janela | Vídeo | Quadros | Duração |
|---|---|---|---|
| seg375 | R, 1080×1920 | 375–824 | 15 s |
| seg600 | R, 1080×1920 | 600–1049 | 15 s |
| inteiro | R, 1080×1920 (e 1920×1080) | 0–2240 | 74,7 s |
| piloto | A–E, R (1920×1080 a partir do quadro 375), S | 120 por célula | 4 s |
| rápida (parcial) | A–E, R | 450 por célula | 15 s |

**R** é um vídeo explicativo de produção com apresentador (talking head), de 75 s: apresentador (H.264 1920×1080, 25 quadros/s, seis takes) e motion graphics, renderizado a 30 quadros/s. Nenhum quadro dele é publicado. **A–E** são sintéticos: A tipografia cinética, B apresentador (tela cheia ↔ cartão, zoom, punch-in, legendas), C grade 2×2 e picture-in-picture (2 a 4 takes ao mesmo tempo), D efeitos pesados (`blur(70px)`, `backdrop-filter`, `feTurbulence`), E slide com quadros quase sempre parados. **S** é um segundo vídeo de produção, só no P0.

### 3.5 O que é estimativa

Antes de existir a medição pelo cgroup, projetamos cerca de 1100 s de CPU para o R inteiro (cerca de 28 s de CPU por segundo de vídeo), olhando os processos durante um render com a máquina carregada. **São estimativas, não medições.** Nenhuma tabela ou figura usa esses valores.

## 4. Sistema

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/pipeline-dark.svg">
  <img alt="A composição React gera um plano de enquadramento em JSON e uma camada de gráficos (PNG com alfa). O ffmpeg decodifica o vídeo gravado pelo Vulkan Video (NVDEC), recorta e posiciona com o libplacebo, mistura os gráficos e codifica com NVENC." src="../figures/pipeline-light.svg" width="100%">
</picture>

*Figura 1. O render em camadas (P2).*

### 4.1 Caminhos

| Caminho | Vídeo gravado | GL do Chrome | Captura | Codificação | Código |
|---|---|---|---|---|---|
| P0 Remotion de fábrica | `<OffthreadVideo>` (compositor do Remotion, CPU) | padrão (sem `--gl`) | JPEG 80 | libx264 CRF 18 | — |
| P1 Remotion na GPU | `<Video>` do `@remotion/media` (WebCodecs, em software no Chrome headless) | `--gl=vulkan` | JPEG 95 | `h264_nvenc` 12 Mb/s, `--hardware-acceleration=required` | `src/remotion-gpu.mjs` |
| P2 Camadas | Vulkan Video (NVDEC) no ffmpeg | `--gl=vulkan`, só gráficos | PNG com alfa | `h264_nvenc` CQ 19, preset p7 | `src/layers/` |
| P3 Camadas + dedup | como P2 | como P2 | PNG, estados repetidos pulados | como P2 | `src/dedup/remotion-dedup.cjs` |

Cada caminho é um pacote de escolhas, como um usuário o usaria. De P0 para P1 mudam quatro coisas de uma vez.

### 4.2 P1: Remotion na GPU

`<Video disallowFallbackToOffthreadVideo />` faz o render falhar em vez de voltar calado ao compositor na CPU. O NVENC troca o `--crf` por taxa de bits, porque o Remotion recusa CRF com aceleração por hardware. **A decodificação continua na CPU**: o `nvidia-smi` mostrou `dec` em 0% em todas as rodadas do P1.

### 4.3 P2: camadas

| Etapa | O que acontece | Custo (seg600, N=3) |
|---|---|---|
| 1. Plano | o esbuild empacota uma entrada pequena que importa a função de enquadramento da composição e o `spring`/`interpolate` do Remotion; para cada take, grava a caixa e o retângulo do take **em cada quadro**, além dos áudios. Validado pelo `plan.schema.json` | 0,2 s de CPU (N=2) |
| 2. Gráficos | a mesma composição, no modo só gráficos, renderiza uma sequência PNG com alfa. Os cantos arredondados do cartão são pintados por uma sombra sólida, então o take embaixo pode ser um retângulo simples | 32,6 s de CPU |
| 3. GPU | um ffmpeg por segmento: decodificação pelo Vulkan Video → `fps=30:round=up` → `libplacebo` [31] com N entradas (fundo, take, gráficos) e expressões `crop_*`/`pos_*` por quadro → `hwupload=derive_device=cuda` → NVENC. Os segmentos se juntam sem recodificar; o áudio se mistura no mesmo passo | 8,5 s de CPU, com o áudio |

Detalhes que importam:

| Escolha | Motivo |
|---|---|
| Curvas por quadro → trechos de reta, guloso, erro ≤ 0,05 px, `if(lt(K,…))` aninhados com `K = floor(ot*30+0.5)` | o libplacebo aceita expressões, não tabelas. Um zoom lento é um trecho; uma mola, de 5 a 25 |
| Entradas e saída marcadas `color_trc=linear`, remarcadas BT.709 depois | o libplacebo mistura em luz linear, o Chrome em gama. Declarando os valores como lineares, o libplacebo mistura como o Chrome |
| `fps=30:round=up` antes do libplacebo | escolhe o mesmo quadro de origem de 25 quadros/s que os componentes de vídeo do Remotion |
| Fundo liso como primeira entrada | cobre o quadro, então o libplacebo nunca limpa um alvo do Vulkan (isso falha na validação) |
| Um ffmpeg por segmento; o segmento também termina onde muda o tipo de cor do PNG | o concat do ffmpeg recusa quadros do Vulkan de decodificadores diferentes; o Chrome grava um quadro todo opaco como RGB, e trocar RGBA ↔ RGB refaz o grafo, o que falha com quadros do Vulkan |
| Teto de tempo por segmento (0,2 s por quadro, mínimo 60 s) e uma nova tentativa | um ffmpeg travou uma vez (todas as threads esperando, sem CPU); o mesmo comando passou na nova tentativa. Causa não encontrada |
| Áudio: `adelay` (amostras exatas) + `volume` + `amix` + `apad` | uma passada de WAV do Remotion renderiza a composição inteira de novo (Seção 6) |

Alcance: um take retangular por vez em cada segmento. Vários takes ao mesmo tempo (vídeo C), máscaras de forma livre, desfoque ou rotação no vídeo gravado não são suportados.

### 4.4 P3: pular quadros de gráficos repetidos

Antes de cada captura, um SHA-256 do estado da página: `documentElement.outerHTML`, todas as regras de CSS (inclusive `adoptedStyleSheets`), valores de formulário, rolagem e tamanho da janela. Um estado já capturado vira um link físico (hard link) para o PNG dele.

| Regra de segurança | Detalhe |
|---|---|
| Sempre capturado | `<canvas>`, `<video>`, `<iframe>`, `<object>`, `<embed>`, `<image>` do SVG, `<img>` não carregada, fontes carregando, animação ou transição de CSS ativa, shadow DOM, folha de estilo de outra origem |
| Não detectado | fundo por `url()` no CSS ainda carregando (isso também quebraria um render normal) |
| Trava de versão | remenda o export interno `takeFrame` do `@remotion/renderer`; recusa qualquer versão que não seja a 4.0.536 |
| Modo de conferência | `RGPU_DEDUP=verify` captura tudo e confere que estados iguais deram PNG idênticos byte a byte |

É uma variante de dedup já conhecido, com outro critério (estado do DOM depois do seek, qualquer quadro anterior, sem saber nada da biblioteca de animação), e não uma ideia nova.

### 4.5 Ferramentas

`bin/doctor.mjs` testa o ffmpeg, o NVENC, a decodificação pelo Vulkan Video, a cadeia libplacebo → CUDA → NVENC, o codificador embutido no Remotion e a contenção, e diz quais caminhos a máquina suporta. `src/measure.mjs` e `src/contain.mjs` implementam as Seções 3.2 e 3.3.

## 5. Avaliação

### 5.1 Para onde vai a CPU

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/cpu-breakdown-dark.svg">
  <img alt="Segundos de CPU para 15 s do vídeo R: 183,53 s no total, decodificação do vídeo gravado 99,3 s (54%), captura de quadros 76,25 s (42%), React e layout 7,98 s (4%)." src="../figures/cpu-breakdown-light.svg" width="100%">
</picture>

*Figura 2. CPU por parte, seg375, N=1 por modo. Fonte: `data/experiments/cpu-breakdown.json`.*

| Parte | CPU (s) | Fatia | Como se chegou |
|---|---|---|---|
| Decodificação e entrega do vídeo gravado (`<OffthreadVideo>`) | 99,30 | 54,1% | completo sem captura − só gráficos sem captura |
| Captura de quadros (screenshot + JPEG) | 76,25 | 41,5% | completo com JPEG − completo sem captura |
| React, layout, inicialização | 7,98 | 4,3% | só gráficos, sem captura (4,41 s de inicialização fixa; ~8,1 ms por quadro além dela) |
| **Total** | **183,53** | | `renderFrames()`, concorrência 4, `--gl=vulkan` |

Só nos gráficos (27,74 s com captura PNG), a captura é 71% (85% sem a inicialização). Ressalva: a subtração supõe que os custos se somam.

### 5.2 Vídeo R, passo a passo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/r-steps-dark.svg">
  <img alt="Segundos de CPU e de parede por segundo de vídeo. Trecho de 15 s: ponto de partida 23,07, Video com NVENC 8,07. Vídeo inteiro: Video com NVENC 6,16, camadas 1,72, camadas com dedup 1,5." src="../figures/r-steps-light.svg" width="100%">
</picture>

*Figura 3. Exportação do R por passo. Duas janelas; não comparar entre elas. Fonte: `data/experiments/r-steps.json`.*

| Passo | Janela | N | CPU (s), média [rodadas] | Parede (s) | CPU/s de vídeo | Pico de memória |
|---|---|---|---|---|---|---|
| Início: `<OffthreadVideo>`, JPEG em disco, `h264_nvenc` à parte | seg375 | 2 | 346,0 [317,5; 374,6] | 53,4 | 23,07 | 6,3 GB |
| `<Video>`, mesmo pipeline | seg375 | 2 | 209,7 [220,8; 198,6] | 58,0 | 13,98 | 3,7 GB |
| `<Video>` + MP4 direto do Remotion, libx264 (controle) | seg375 | 2 | 176,8 [175,2; 178,5] | 33,7 | 11,79 | 3,7 GB |
| `<Video>` + MP4 direto do Remotion, NVENC | seg375 | 2 | 121,1 [125,9; 116,3] | 29,9 | 8,07 | 3,2 GB |
| **P1**, com áudio | inteiro | **1** | 460,3 | 110,7 | 6,16 | 3,8 GB |
| **P2** camadas | inteiro | 4 | 128,5 [143,2; 131,0; 125,7; 114,1] | 52,3 | 1,72 | — |
| **P3** camadas + dedup | inteiro | 4 | 112,2 [137,0; 104,0; 107,5; 100,4] | 49,0 | 1,50 | — |

- seg375: do início às configurações do P1, CPU −65% (N=2 em cada). Pelas médias: `<Video>` −39%, MP4 direto do Remotion −16%, NVENC no lugar do libx264 −32%.
- Vídeo inteiro: P1 / P3 = **4,1× em CPU, 2,3× em parede**. O P1 tem N=1 e não foi alternado com P2/P3; as rodadas de P2 e P3 foram alternadas.
- Uma rodada anterior do P1 no vídeo inteiro, com as mesmas configurações mas com a máquina mais carregada e outros renders sem contenção, gastou 701 s de CPU (175 s de parede). Usamos o valor menor (460 s, que se repete com 460,2 s na versão 1920×1080) para a razão de 4,1× ser a conservadora; com a rodada anterior seria 6,2×.
- Versão 1920×1080, N=1 cada: P1 460,2 s, P2 114,4 s, P3 101,0 s de CPU.
- O `dec` ficou em 0% em todas as rodadas do P1: o WebCodecs decodifica em software no Chrome headless.

### 5.3 Render em camadas por etapa (seg600)

A referência aqui é um render completo do Remotion com `<OffthreadVideo>`, JPEG + NVENC, sem áudio. Load 3–4. Fonte: `data/experiments/layers-segment.json`.

| Etapa | N | CPU (s) [rodadas] | Parede (s) | Memória | GPU sm/enc/dec |
|---|---|---|---|---|---|
| Render completo do Remotion | 3 | 221,8 [214,2; 226,0; 225,2] | 36,9 | 6,4 GB | 9/2/0% |
| Camadas: plano | 2 | 0,2 | 0,1 | 0,06 GB | — |
| Camadas: gráficos (PNG + alfa) | 3 | 32,6 [32,0; 32,9; 33,0] | 11,0 | 1,1 GB | 11/1/0% |
| Camadas: ffmpeg na GPU + áudio | 3 | 8,5 [8,5; 8,7; 8,4] | 6,3 | 0,5 GB | 11/8/1% |
| **Camadas: total** | | **41,3** | **17,4** | | |

5,4× menos CPU, 2,1× menos parede. Dos 8,5 s do ffmpeg, 3,6 s são a decodificação dos PNG. Uma rodada do ffmpeg com load 16 levou 13 s e ficou fora da média.

### 5.4 Equivalência com o Chrome

Correções achadas comparando com o render do Chrome (seg600, N=1; fonte `data/experiments/quality-r.json`):

| Correção | SSIM antes | depois |
|---|---|---|
| Misturar no espaço do Chrome (marcar como linear, remarcar BT.709) | 0,944 | 0,958 |
| Quadro de origem com `fps=30:round=up` | 0,958 | 0,974 |
| Escala bilinear no lugar da spline36 (rejeitada) | 0,974 | 0,949 |

Resultado no seg600: média 0,9746, mínima 0,9647; piso de ruído (o MP4 de referência contra os próprios quadros JPEG) 0,9855.

Vídeo inteiro contra o P1, N=1:

| Bloco | 1080×1920 média (mínima) | 1920×1080 média (mínima) |
|---|---|---|
| 1 tela cheia, punch-in | 0,968 (0,736) | 0,973 (0,677) |
| 2 mola para o cartão, mapa | 0,983 (0,967) | 0,986 (0,963) |
| 3 tela cheia, zoom 1,1, punch-in | 0,968 (0,816) | 0,974 (0,910) |
| 4 cartão, formulário | 0,983 (0,544) | 0,985 (0,544) |
| 5 cartão, formulário, pausa depois do fim do take | 0,986 (0,981) | 0,987 (0,982) |
| 6 tela cheia, punch-in, faixa | 0,967 (0,744) | 0,973 (0,680) |
| encerramento, sem vídeo gravado | 1,000 (1,000) | 1,000 (0,999) |
| **inteiro** | **0,978** | **0,981** |

As mínimas são quadros soltos (123, 965, 1010, 1960, 1961) entre vizinhos a ~0,97: o WebCodecs e o `fps=30:round=up` escolhem um quadro de origem de 25 quadros/s diferente em poucos pontos. Lado a lado, não se vê. Áudio: atraso de 0 a 0,33 ms, resíduo de −58 a −62 dB por bloco.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/quality-dark.svg">
  <img alt="SSIM médio de cada caminho contra uma referência quase sem perda, ao lado do piso de ruído do seu codificador. Todos os caminhos ficam a até 0,008 do piso; a maioria a até 0,002." src="../figures/quality-light.svg" width="100%">
</picture>

*Figura 4. Qualidade no piloto, 120 quadros, N=1. Fonte: `data/benchmark/pilot-quality.csv`.*

Piloto: SSIM de cada caminho menos o piso de ruído do próprio codificador. Referência: P0 capturado em PNG → ProRes 4444 XQ (no R, o P1).

| Vídeo | P0 | P1 | P2 |
|---|---|---|---|
| A tipografia | +0,0050 | −0,0001 | −0,0077 |
| B apresentador 1080p | +0,0011 | +0,0008 | −0,0015 |
| B apresentador 4K | +0,0016 | +0,0013 | −0,0003 |
| C vários vídeos | +0,0006 | −0,0042 | n/a |
| D efeitos | +0,0011 | −0,0003 | −0,0017 |
| E slide | +0,0001 | +0,0000 | −0,0004 |
| R produção | ref. | +0,0001 | −0,0023 (mín. 0,958) |

### 5.5 Dedup (P3)

Vídeo R inteiro, rodadas alternadas, load 4–9 (uma rodada isolada pode errar ~15%). Fonte: `data/experiments/improvements.json`.

| Medida | Valor |
|---|---|
| Quadros reaproveitados | 652 de 2241 (29%) |
| CPU dos gráficos, antes → depois | 89,7 s (N=6) → 74,2 s (N=2), −17% |
| Parede dos gráficos | 31,4 s → 28,8 s |
| Modo de conferência | 1584 estados, 657 repetições, **0** PNG diferentes (byte a byte) |
| SSIM contra o P2 | 0,99698 (mín. 0,9917); nova rodada do P2 contra ele mesmo 0,99723 (mín. 0,9919). 1920×1080: 0,99645 |

Na rodada rápida parcial (15 s, N=1): o E (slide) reaproveitou 80% dos quadros e caiu de 1,29 para 0,82 s de CPU por segundo de vídeo; o B reaproveitou 2% e não mudou.

### 5.6 Benchmark: piloto e rodada rápida parcial

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/pilot-dark.svg">
  <img alt="Benchmark piloto, N=1, 4 segundos por célula, só indicativo. Segundos de CPU por segundo de vídeo para P0, P1 e P2. O P1 ganha em vídeos sem vídeo gravado e com vários takes ao mesmo tempo; o P2 ganha nos vídeos com apresentador e no vídeo de produção." src="../figures/pilot-light.svg" width="100%">
</picture>

*Figura 5. Piloto, N=1, 4 s por célula. Só indicativo. Fonte: `data/benchmark/pilot-summary.json`.*

**Piloto** (N=1, 4 s, 120 quadros; 5 das 20 rodadas medidas começaram depois de a espera estourar: B 1080p P1 e P2, B 4K P1 e P2, A P2). Segundos de CPU por segundo de vídeo:

| Vídeo | P0 | P1 | P2 | Melhor |
|---|---|---|---|---|
| A tipografia | 4,66 | **1,64** | 3,07 | P1 |
| B apresentador 1080p | 14,24 | 4,75 | **3,20** | P2 |
| B apresentador 4K | 43,03 | 9,83 | **5,84** | P2 |
| C vários vídeos | 43,94 | **11,99** | n/a | P1 |
| D efeitos | 11,85 | **1,71** | 5,11 | P1 |
| E slide | 3,43 | **1,85** | 1,89 | P1 ≈ P2 |
| R produção (1920×1080) | n/a | 12,49 | **5,33** | P2 |
| S produção | 18,75 | n/a | n/a | — |

**Rodada rápida, interrompida** (planejada com N=3 e 76 rodadas; parou depois de 45: 19 de aquecimento, 23 medidas, 3 que não se aplicam; sem passada de qualidade). Segundos de CPU por segundo de vídeo, trechos de 15 s:

| Vídeo | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| A | 2,55 | **1,40** | 1,58 | — |
| B 1080p | 10,63 | 3,57 | **1,61** | 1,62 |
| C | 30,52 (n=2) | **8,96** | n/a | n/a |
| D | 9,46 (n=2) | **1,15** | 3,97 | — |
| E | 1,95 (n=2) | 1,01 | 1,29 | **0,82** |
| R | n/a | 6,87 | 1,94 (n=2) | **1,65** |

n=1 quando não indicado. Trechos mais longos baixam a CPU por segundo (a inicialização pesa menos), então as duas tabelas não são comparáveis.

Hipóteses registradas antes, conferidas só contra o piloto:

| Hipótese | O piloto diz |
|---|---|
| H1 com apresentador, P2 < P1 < P0 | coerente (B, R) |
| H2 sem vídeo gravado, P2 não ganha do P1 | coerente (A e D piores; E empata) |
| H3 efeitos pesados ganham mais com o P1 | coerente (D −86% contra o P0) |
| H4 a CPU cresce com takes simultâneos | coerente (C 43,9 contra B 14,2 no P0) |
| H5 de 1080p para 4K cresce ~4× no P0/P1 | não coerente: 3,0× no P0, 2,1× no P1, 1,8× no P2 (a inicialização pesa em 4 s) |
| H6 qualidade perto do piso do codificador | coerente (a até 0,008) |

### 5.7 Escolha do caminho

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/decision-dark.svg">
  <img alt="Guia de decisão. Sem vídeo gravado: P1. Um take retangular por vez: camadas com dedup. Vários takes ao mesmo tempo, máscaras, rotação ou desfoque no vídeo gravado: P1. Quadros quase sempre parados: o dedup ajuda." src="../figures/decision-light.svg" width="100%">
</picture>

*Figura 6. Qual caminho usar, a partir das Seções 5.2 a 5.6.*

## 6. Resultados negativos

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../figures/negative-dark.svg">
  <img alt="Seis abordagens que não compensaram: decodificação por hardware dentro do Chrome headless, capturar só a área que mudou, o Experimental.Clipper removido do Remotion, captura por memória compartilhada com NVENC para os gráficos, ProRes ou VP9 com alfa para a camada de gráficos e vários segmentos do ffmpeg ao mesmo tempo." src="../figures/negative-light.svg" width="100%">
</picture>

*Figura 7. O que não funcionou. Fonte: `data/negative-results.json`.*

| Tentativa | Resultado | Por quê | Medido |
|---|---|---|---|
| **NVDEC pelo VA-API dentro do Chrome headless** | o processo de GPU cai quando o quadro decodificado vai para a composição; `dec` fica em 0% | o `chrome-headless-shell` não tem VA-API. O Chrome for Testing com o `nvidia-vaapi-driver` 0.0.18 abre o decodificador (`isConfigSupported` verdadeiro só com `--gl=angle-egl`), mas o processo de GPU sai quando o quadro decodificado vai para a composição («GPU process exited unexpectedly»). O Chrome for Testing também não tem a captura por memória compartilhada do Remotion | — |
| **Dirty rects** (capturar só a área que mudou e recompor no Node) | mais lento e não idêntico pixel a pixel | a detecção acertou (0 pixels diferentes fora do recorte em 2241 quadros), mas o Chrome rasteriza diferente com recorte: 816 quadros diferem dentro dele (cantos arredondados até 255 num canal quase transparente; desfoque da sombra ±3). Não muda desligando o `captureBeyondViewport` nem alinhando a 256 px | área de 28% do quadro; captura 81 → 62 s de CPU (N=2); recomposição 32,4 s contra 8,1 s do ffmpeg decodificando PNG inteiros |
| `Experimental.Clipper` do Remotion (trabalho anterior) | removido em 2024 | «did not actually make the render faster, rather slower» [6] | — |
| **Captura por memória compartilhada + NVENC para a camada de gráficos** | mais CPU que o PNG | codificar dentro do pipeline do render somou CPU | 35,3 contra 27,7 s (N=1, seg375) |
| ProRes 4444 / VP9 com alfa para a camada de gráficos | mais CPU para codificar do que economiza | decodificar o PNG custa só 3,6 s | codificação +86,8 s (ProRes), +20,0 s (VP9); decodificação 9,7 / 1,2 contra 3,6 s (N=2) |
| Vários segmentos do ffmpeg ao mesmo tempo | menos parede, mais CPU; desligado por padrão | | 2 jobs: parede 20,0 → 14,5 s, CPU 36,9 → 44,4 s, +1,3 GB de VRAM; 3 jobs: 14,0 s, 53,7 s (N=2) |
| Passada de WAV do Remotion para o áudio | renderiza a composição inteira de novo | | 617,7 s de CPU, 15 GB, 81 s de parede para 74,7 s de áudio (N=2) |
| Escala bilinear no libplacebo | pior aproximação | | SSIM 0,974 → 0,949 |
| Codificação `h264_vulkan`; `hwmap` de Vulkan para CUDA; um concat entre decodificadores | falharam | não implementado / recusado | — |

## 7. Discussão

- **O gargalo é o vídeo gravado e a captura, não o React.** React e layout foram 4% da CPU no seg375. Otimizar o código dos componentes ajuda pouco; tirar o vídeo gravado do Chrome ajuda.
- **Documentação de GPU do Remotion contra esta máquina.** A página «Using the GPU» põe a decodificação de vídeo entre o que a GPU acelera [3]. No Linux, com placa NVIDIA e o shell headless do Remotion, medimos `dec` em 0% tanto com `<OffthreadVideo>` quanto com `<Video>`. É o que medimos aqui, não uma regra geral.
- **O P1 é o primeiro passo barato.** É uma configuração oficial, não exige código novo e cortou 65% da CPU no seg375.
- **O P2 só compensa quando o vídeo gravado domina.** Sem ele, troca o JPEG pela captura PNG, mais cara, e soma uma passada do ffmpeg (piloto: A, D).
- **O dedup depende do conteúdo.** 29% de reaproveitamento no R, 80% num slide, 2% numa cena de apresentador com legendas em movimento.
- **A parede melhora menos que a CPU.** Sob o mesmo teto de 8 threads, o P3 foi 2,3× mais rápido em parede e 4,1× mais barato em CPU no R. O objetivo era a CPU.
- **Por que ainda escolher o P1.** Vários takes ao mesmo tempo, máscaras, rotação ou desfoque no vídeo gravado, ou qualquer elemento que o plano não descreve.

## 8. Limitações e ameaças à validade

| Ameaça | Detalhe | Mitigação |
|---|---|---|
| N pequeno | piloto com N=1 e 4 s; rodada rápida interrompida, quase toda com n=1; P1 do vídeo inteiro com N=1 | indicado em todo lugar; a rodada completa é trabalho futuro |
| Máquina compartilhada e carregada | load de 3 a 9 no início das rodadas; 5 das 20 rodadas do piloto começaram depois de a espera estourar | contenção, espera pela máquina quieta, ordem sorteada ou alternada |
| GPU compartilhada | o llama-server ocupava ~21 GB; as colunas da GPU são da placa inteira; picos durante a rodada não são vistos | ocioso na amostra antes de cada rodada |
| Cache | o aquecimento é de 4 s, não da duração completa | a ordem sorteada espalha o efeito |
| Construto: CPU | a CPU do cgroup não conta trabalho do driver da NVIDIA fora do escopo | mede o que o render tira dos outros serviços |
| Construto: qualidade | SSIM e PSNR são aproximações; sem VMAF. Um caminho que escolhe outro quadro de origem aparece como perda mesmo que nenhum dos dois esteja «certo» | piso de ruído por codificador |
| Caminhos em pacote | cada caminho muda várias coisas; as razões descrevem o pacote | ablação do P1 no seg375 |
| Histórico da ferramenta de medição | o primeiro teste de viabilidade usou `/usr/bin/time` (Tabela 1) | usado só como motivação |
| Externa | uma máquina, uma GPU, uma versão do Remotion, do Chrome e do ffmpeg; os vídeos sintéticos representam tipos, não uma distribuição; o R é um vídeo só | harness aberto para outras máquinas |
| Alcance da comparação | o HyperFrames não entrou no benchmark (instalá-lo não foi permitido na sessão, e as composições teriam de ser reescritas em HTML + GSAP) | trabalho futuro |
| Fragilidade | o dedup remenda internals do Remotion e está travado na 4.0.536 | recusa outras versões |
| Travamento raro | um ffmpeg travou uma vez; causa desconhecida | teto de tempo e nova tentativa |

**Tabela 1.** Primeiro teste de viabilidade, um take de 12,4 s com uma camada transparente, N=1, `/usr/bin/time` (correto aqui: o ffmpeg é um processo só), logs brutos não guardados. Fonte: `data/experiments/first-test.json`.

| Caminho do ffmpeg | Parede | CPU |
|---|---|---|
| Software (decodificação, escala, overlay, libx264) | 5,6 s | 46,8 s |
| CUDA (NVDEC, `scale_cuda`, `overlay_cuda`, NVENC) | 5,0 s | 12,1 s |
| libplacebo (Vulkan), recorte 9:16 animado + camada, NVENC | 3,7 s | 9,4 s |

## 9. Trabalhos futuros

| Item | Detalhe |
|---|---|
| Rodada completa | `npm run bench:full`: N≥5, 30 s, 1080p e 4K, todas as células, com a máquina quieta e intervalos por bootstrap |
| Outro hardware | GPU integrada AMD (Vulkan Video, VA-API); só CPU (`--device cpu`: P1 com GL em software e libx264, P2/P3 não se aplicam); NVIDIA T4 no Kaggle ou no Colab |
| Resultados da comunidade | o `bench/run.mjs` gera um `submission.json` para anexar a uma issue de resultado de benchmark |
| HyperFrames | os mesmos tipos de vídeo, com e sem o dedup dele |
| Vários takes ao mesmo tempo | plano e script para N takes simultâneos (o libplacebo já aceita N entradas) |
| Moldura do cartão num shader | desenhar sombra e filete na GPU em vez de na camada de gráficos |

## 10. Reprodutibilidade

| O quê | Como |
|---|---|
| Conferir a máquina | `npm run doctor` |
| Exemplo, os dois caminhos | `npm run example:footage`, `npm run example:p1`, `npm run example:layers`, `npm run example:compare` (vídeo sintético, sem pessoa real) |
| Benchmark | `npm run bench:smoke` (N=1, 4 s), `npm run bench:quick` (N=3, 15 s), `npm run bench:full` (N=5, 30 s, 1080p e 4K) |
| Um recorte | `node bench/run.mjs --videos B --paths P1,P2 --res 1080p,4k --n 3` |
| O seu próprio projeto | `node bench/run.mjs --external <pasta> --external-comp <id> --external-layers "<comando>"` |
| Análise | `npm run bench:analyze` → `analysis.md`, `chart.html`, `submission.json` |
| Medir qualquer comando | `node src/measure.mjs --runs 2 -- <comando>` |
| Testes | `npm test` |
| Dados | `data/README.md` lista, para cada arquivo, a fonte, o N, a duração do trecho e a carga |

Observações:

- Dependências fixadas: `remotion`, `@remotion/cli`, `@remotion/renderer`, `@remotion/media` 4.0.536. Semente do sorteio: 20261029.
- Os números de `data/` foram medidos com o harness interno de onde veio o `bench/` deste repositório, na mesma máquina e no mesmo dia. Na versão pública, B e C usam vídeo sintético gerado em vez de takes reais, então os números absolutos de B e C vão diferir.
- Os vídeos R e S não são publicados. Listas de processos, ids, caminhos e linhas de comando do servidor foram retirados de `data/`.

## Agradecimentos

Desenvolvido com o Claude Code.

## Referências

1. Remotion. «Performance». https://www.remotion.dev/docs/performance
2. Remotion. «Hardware acceleration». https://www.remotion.dev/docs/hardware-acceleration
3. Remotion. «Using the GPU». https://www.remotion.dev/docs/gpu
4. Remotion. Issue #4364, «Initial hardware acceleration support», 2024. https://github.com/remotion-dev/remotion/issues/4364
5. Remotion. PR #12109, captura mais rápida com o Chromium v4, 2026. https://github.com/remotion-dev/remotion/pull/12109
6. Remotion. `Experimental.Clipper` (docs da v3) e a remoção: issue #4468, PR #4471, 2024. https://v3.remotion.dev/docs/clipper · https://github.com/remotion-dev/remotion/issues/4468 · https://github.com/remotion-dev/remotion/pull/4471
7. Remotion. «Transparent videos». https://www.remotion.dev/docs/transparent-videos
8. Remotion. «Client-side rendering». https://www.remotion.dev/docs/client-side-rendering/
9. Remotion. `<Video>` do `@remotion/media`. https://www.remotion.dev/docs/media/video
10. HyperFrames (HeyGen). Repositório. https://github.com/heygen-com/hyperframes
11. HyperFrames. PR #1549, reaproveitamento de quadros estáticos repetidos, 2026. https://github.com/heygen-com/hyperframes/pull/1549
12. HyperFrames. PR #2248, reaproveitamento sem dano no BeginFrame, 2026. https://github.com/heygen-com/hyperframes/pull/2248
13. HyperFrames. PR #268, compositor HDR em camadas, 2026. https://github.com/heygen-com/hyperframes/pull/268
14. HeyGen. «HTML to Video Was Not Easy: Here's How We Solved It», 2026. https://www.heygen.com/research/html-to-video
15. Replit. «We Built a Video Rendering Engine by Lying to the Browser About What Time It Is», 2026. https://replit.com/blog/browsers-dont-want-to-be-cameras
16. WebVideoCreator. https://github.com/Vinlic/WebVideoCreator
17. timecut e timesnap. https://github.com/tungs/timecut · https://github.com/tungs/timesnap
18. Motion Canvas, docs de render; Revideo. https://motioncanvas.io/docs/rendering/ · https://github.com/redotvideo/revideo
19. Editly. https://github.com/mifi/editly
20. iLoveVideoEditor. «How We Cut Our Browser Video Renderer's Frame Time by 80%». https://dev.to/ilovevideoeditor/how-we-cut-our-browser-video-renderers-frame-time-by-80-3db1
21. OpenMontage. Issue #45, render em dois planos, 2026. https://github.com/solafidei/OpenMontage/issues/45
22. remotion-ffmpeg-skill, 2026; ffmpeg-skill PR #353. https://github.com/kajisho5/remotion-ffmpeg-skill · https://github.com/kajisho5/ffmpeg-skill/pull/353
23. scorsese. Issue #775, 2026. https://github.com/MatthewLacerda2/scorsese/issues/775
24. Shotstack. «Rendering speeds benchmark», 2024. https://shotstack.io/learn/rendering-speeds-benchmark/
25. CasparCG Server; produtor HTML; protocolo AMCP. https://github.com/CasparCG/server · https://casparcg.com/docs/wiki/server/producers/html-producer · https://github.com/CasparCG/help/wiki/AMCP-Protocol
26. OBS `obs-browser`. https://github.com/obsproject/obs-browser
27. CEF `cef_render_handler.h` (`OnPaint`, `dirtyRects`). https://github.com/chromiumembedded/cef/blob/master/include/cef_render_handler.h
28. Chrome DevTools Protocol, `HeadlessExperimental.beginFrame`. https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/
29. GStreamer: `wpesrc`, `glvideomixer`, `GstInterpolationControlSource`. https://gstreamer.freedesktop.org/documentation/wpe/wpesrc.html · https://gstreamer.freedesktop.org/documentation/opengl/glvideomixer.html · https://gstreamer.freedesktop.org/documentation/controller/gstinterpolationcontrolsource.html
30. NVIDIA DeepStream `Gst-nvdsosd`. https://docs.nvidia.com/metropolis/deepstream/dev-guide/text/DS_plugin_gst-nvdsosd.html
31. Filtros do FFmpeg: `libplacebo`. https://ffmpeg.org/ffmpeg-filters.html#libplacebo
32. Filtros do FFmpeg: `mpdecimate`. https://ffmpeg.org/ffmpeg-filters.html#mpdecimate
33. W3C. WebCodecs, Working Draft, 2026. https://www.w3.org/TR/webcodecs/
34. Documentação do Lottie. https://lottiefiles.github.io/lottie-docs/
35. Mediabunny. https://github.com/Vanilagy/mediabunny
36. Vidformer. arXiv:2601.17221, 2026. https://arxiv.org/abs/2601.17221 · https://github.com/ixlab/vidformer
37. V2V. ICDE 2024 (gramática declarativa de transformações de vídeo). https://doi.org/10.1109/icde60146.2024.00449
38. Vega-Video. arXiv:2604.24958, 2026. https://arxiv.org/abs/2604.24958
39. Rendering Elimination. arXiv:1807.09449, 2018. https://arxiv.org/abs/1807.09449
40. Tese de doutorado, Universitat Politècnica de Catalunya, 2020 (redundância entre quadros no render da GPU). https://doi.org/10.5821/dissertation-2117-192448
41. URL2Video. UIST 2020. https://doi.org/10.1145/3379337.3415814
42. Motion vectorization. ACM TOG 2023. https://doi.org/10.1145/3618316
43. gMotion. Graphics Interface 2018. https://doi.org/10.20380/gi2018.14
44. MoVer. arXiv:2502.13372. https://arxiv.org/abs/2502.13372
45. DataMagic. arXiv:2606.20388, 2026. https://arxiv.org/abs/2606.20388
46. Google. Patente US 8.913.067 B1, concedida em 2014 (composição acelerada por GPU no navegador, refazendo só as camadas «dirty»). https://patents.google.com/patent/US8913067B1/en
47. Zoox. Patente US 12.469.289 B1, concedida em 2025 (captura de vídeo por screenshots automatizados num navegador headless). https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12469289
