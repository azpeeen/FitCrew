<div align="center">
  <img src="./public/img/logo.png" alt="GymBros Logo" width="120"/>

  <h1>GymBros</h1>

  <p><strong>Sua academia inteligente no bolso.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"/>
    <img src="https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express"/>
    <img src="https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL"/>
    <img src="https://img.shields.io/badge/Groq_AI-F55036?style=for-the-badge&logo=groq&logoColor=white" alt="Groq AI"/>
    <img src="https://img.shields.io/badge/Cloudinary-3448C5?style=for-the-badge&logo=cloudinary&logoColor=white" alt="Cloudinary"/>
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA"/>
  </p>

  <p>
    <a href="https://gymbros.app.br" target="_blank">
      <img src="https://img.shields.io/badge/🌐_Ver_ao_vivo-gymbros.app.br-22c55e?style=for-the-badge" alt="Ver ao vivo"/>
    </a>
  </p>
</div>

---

## Índice

- [Sobre](#sobre)
- [Demo](#demo)
- [Features](#features)
- [Como funciona](#como-funciona)
- [Tech Stack](#tech-stack)
- [Highlights técnicos](#highlights-técnicos)
- [Autor](#autor)

---

## Sobre

GymBros é uma plataforma PWA de saúde e bem-estar que transforma a experiência de quem treina. Do check-in ao prato de comida, passando pelo treino guiado e pelo acompanhamento de evolução — tudo acontece num único produto, acessível pelo celular como app nativo, sem instalação.

A inteligência artificial está no centro de tudo. O usuário preenche seu perfil uma vez, e a IA gera treinos e dietas completamente personalizados, analisa fotos de refeições para estimar calorias em tempo real, e responde dúvidas via chat com suporte a áudio. Cada interação é contextualizada — a IA sabe o histórico, o objetivo e o momento do usuário.

Construído offline-first e mobile-first, o GymBros usa Service Workers para garantir funcionalidade mesmo sem conexão, Web Push VAPID para notificações nativas no celular, e uma arquitetura pensada para escalar. É a experiência de um app premium, entregue direto do navegador.

---

## Demo

<div align="center">
  <img src="./assets/demo.gif" alt="GymBros Demo" width="800"/>
  <br/>
  <em>Screenshots e gravações em breve. Acesse <a href="https://gymbros.app.br">gymbros.app.br</a> para ver ao vivo.</em>
</div>

---

## Features

<table align="center" width="100%">
  <tr>
    <td align="center" width="50%" valign="top" style="padding: 16px;">
      <h3>🤖 Personal Trainer IA</h3>
      <p>Treinos e dietas gerados por IA com base no perfil do usuário — com preview completo e confirmação antes de salvar.</p>
    </td>
    <td align="center" width="50%" valign="top" style="padding: 16px;">
      <h3>🏋️ Execução de Treino</h3>
      <p>Modo guiado com GIFs animados por exercício, cronômetro integrado e registro de carga por série.</p>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>📊 Histórico e Evolução</h3>
      <p>Gráficos de progresso por exercício ao longo do tempo, com visualização de carga máxima e volume total.</p>
    </td>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>✅ Check-in</h3>
      <p>Registro de presença na academia com sistema de streak — mantém o usuário engajado e consistente.</p>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>🍎 Nutrição com IA</h3>
      <p>Foto de refeição analisada por visão computacional para estimar calorias e macronutrientes em segundos.</p>
    </td>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>💧 Hidratação</h3>
      <p>Lembretes de água configuráveis disparados via Service Worker, mesmo com o app em segundo plano.</p>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>😴 Monitoramento de Sono</h3>
      <p>Lembretes de sono e registro de horas dormidas para acompanhar a recuperação e o desempenho.</p>
    </td>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>🔔 Notificações Push</h3>
      <p>Web Push VAPID com notificações nativas no celular, sem depender de app instalado.</p>
    </td>
  </tr>
  <tr>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>💬 Chat IA com Áudio</h3>
      <p>Chat com histórico persistente, sidebar de conversas e entrada por voz transcrita via Whisper.</p>
    </td>
    <td align="center" valign="top" style="padding: 16px;">
      <h3>📱 PWA Nativa</h3>
      <p>Instalável direto do navegador, com cache offline-first e experiência idêntica a um app nativo.</p>
    </td>
  </tr>
</table>

---

## Como funciona

**1️⃣ Cadastro** — O usuário cria sua conta em segundos, direto pelo celular ou desktop.

**2️⃣ Perfil** — Preenche objetivo, nível de treino, restrições alimentares e disponibilidade semanal.

**3️⃣ IA gera o plano** — A IA analisa o perfil e entrega treino completo + plano alimentar personalizados, com preview antes de confirmar.

**4️⃣ Executa e evolui** — O usuário treina com modo guiado, registra cargas, acompanha o progresso em gráficos e recebe ajustes automáticos ao longo do tempo.

---

## Tech Stack

| | Tecnologia | Uso |
|---|---|---|
| ⚙️ | **Node.js + Express** | Servidor HTTP, rotas, middlewares e autenticação |
| 🗄️ | **MySQL (Clever Cloud)** | Banco de dados relacional em produção |
| 🤖 | **Groq — llama-3.3-70b** | Geração de treinos, dietas e respostas do chat |
| 👁️ | **Groq — llama-4-scout** | Análise de imagens de refeições (visão computacional) |
| 🎙️ | **Groq — Whisper** | Transcrição de áudio para texto no chat |
| 🖼️ | **Cloudinary** | Upload, otimização e entrega de imagens e GIFs |
| 📄 | **EJS** | Templates server-side com componentes reutilizáveis |
| 📲 | **PWA + Service Worker** | Instalação nativa, cache offline e notificações push |
| 🔔 | **Web Push VAPID** | Notificações push sem app — direto no celular |
| 🚀 | **Render** | Deploy contínuo em produção |

---

## Highlights técnicos

- **Web Push VAPID** — notificações push implementadas do zero com geração de chaves, subscription persistida no banco e envio server-side via `web-push`
- **Two-step AI intent detection** — o chat detecta a intenção do usuário antes de chamar a IA, evitando chamadas desnecessárias e reduzindo latência
- **Fuzzy search com Fuse.js** — busca tolerante a erros de digitação no catálogo de exercícios, sem depender de banco
- **Optimistic UI** — atualizações de interface aplicadas antes da resposta do servidor para uma experiência percebida mais rápida
- **Service Worker offline-first** — estratégia cache-first com fallback de rede, garantindo funcionalidade mesmo sem conexão
- **Vision pipeline** — fluxo completo de upload → compressão → análise por LLM multimodal → resposta estruturada em JSON
- **Streaming de resposta IA** — respostas do chat entregues em tempo real via SSE (Server-Sent Events), sem aguardar o payload completo

---

## Autor

<div align="center">
  <img src="https://github.com/azpeeen.png" width="96" style="border-radius: 50%;" alt="Davi Martins"/>
  <br/>
  <strong>Davi Martins</strong>
  <br/>
  <em>Desenvolvedor full stack, 17 anos</em>
  <br/><br/>
  <a href="https://github.com/azpeeen">
    <img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"/>
  </a>
  <a href="linkedin.com/in/davi-martins-dos-santos-a0784a324">
    <img src="https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/>
  </a>
</div>
