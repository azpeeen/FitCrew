'use strict';

function getCookieLang() {
    const match = document.cookie
        .split('; ')
        .find(r => r.startsWith('gymbros_lang='));
    return match ? decodeURIComponent(match.split('=')[1]) : 'pt';
}

function setCookieLang(lang) {
    document.cookie = `gymbros_lang=${encodeURIComponent(lang)}; path=/; max-age=31536000; SameSite=Lax`;
}

const VALID_LANGS = ['pt', 'en', 'es'];

const dictionary = {
    /* ── navegação ─────────────────────────────────────── */
    'nav.home': { pt: 'Home', en: 'Home', es: 'Inicio' },
    'nav.academias': { pt: 'Academias', en: 'Gyms', es: 'Gimnasios' },
    'nav.about': { pt: 'Sobre nós', en: 'About us', es: 'Sobre nosotros' },
    'nav.planos': { pt: 'Planos e Preços', en: 'Plans & Pricing', es: 'Planes y Precios' },
    'nav.login': { pt: 'Entrar', en: 'Log in', es: 'Ingresar' },

    /* ── sidebar ────────────────────────────────────────── */
    'sidebar.painel':   { pt: 'Painel',              en: 'Dashboard',         es: 'Panel' },
    'sidebar.treinos':  { pt: 'Meus Treinos',        en: 'My Workouts',       es: 'Mis Entrenamientos' },
    'sidebar.evolucao': { pt: 'Evolução',            en: 'Progress',          es: 'Progreso' },
    'sidebar.nutricao': { pt: 'Nutrição',            en: 'Nutrition',         es: 'Nutrición' },
    'sidebar.plano':    { pt: 'Meu Plano',           en: 'My Plan',           es: 'Mi Plan' },
    'sidebar.config':   { pt: 'Configurações',       en: 'Settings',          es: 'Configuración' },
    'sidebar.ai':       { pt: 'Personal Trainer IA', en: 'AI Personal Trainer', es: 'Entrenador IA' },
    'sidebar.avaliacao':{ pt: 'Avaliação Corporal',  en: 'Body Assessment',   es: 'Evaluación Corporal' },
    'sidebar.imc':      { pt: 'Meu Perfil IMC',      en: 'My BMI Profile',    es: 'Mi Perfil IMC' },
    'sidebar.scan':       { pt: 'Escanear equipamento', en: 'Scan equipment',     es: 'Escanear equipo' },
    'sidebar.conquistas': { pt: 'Conquistas',          en: 'Achievements',      es: 'Logros' },
    'sidebar.suporte':  { pt: 'Suporte',             en: 'Support',           es: 'Soporte' },
    'sidebar.role':     { pt: 'Aluno FitCrew',       en: 'FitCrew Member',    es: 'Miembro FitCrew' },

    /* ── botões globais ─────────────────────────────────── */
    'btn.login':       { pt: 'Entrar',           en: 'Log in',        es: 'Ingresar' },
    'btn.register':    { pt: 'Registrar',        en: 'Register',      es: 'Registrarse' },
    'btn.save':        { pt: 'Salvar',           en: 'Save',          es: 'Guardar' },
    'btn.cancel':      { pt: 'Cancelar',         en: 'Cancel',        es: 'Cancelar' },
    'btn.next':        { pt: 'Avançar',          en: 'Next',          es: 'Siguiente' },
    'btn.back':        { pt: 'Voltar',           en: 'Back',          es: 'Atrás' },
    'btn.send':        { pt: 'Enviar',           en: 'Send',          es: 'Enviar' },
    'btn.logout':      { pt: 'Sair',             en: 'Log out',       es: 'Salir' },
    'btn.edit':        { pt: 'Editar',           en: 'Edit',          es: 'Editar' },
    'btn.geolocate':   { pt: 'Usar minha localização', en: 'Use my location', es: 'Usar mi ubicación' },
    'btn.subscribe':   { pt: 'Assinar',          en: 'Subscribe',     es: 'Suscribirse' },
    'btn.upgrade':     { pt: 'Upar de Plano',    en: 'Upgrade Plan',  es: 'Mejorar Plan' },
    'btn.cancel.plan': { pt: 'Cancelar Plano',   en: 'Cancel Plan',   es: 'Cancelar Plan' },

    /* ── formulários ────────────────────────────────────── */
    'form.name':       { pt: 'Nome completo',    en: 'Full name',         es: 'Nombre completo' },
    'form.email':      { pt: 'E-mail',           en: 'Email',             es: 'Correo electrónico' },
    'form.password':   { pt: 'Senha',            en: 'Password',          es: 'Contraseña' },
    'form.confirm.pw': { pt: 'Confirmar senha',  en: 'Confirm password',  es: 'Confirmar contraseña' },
    'form.cpf':        { pt: 'CPF (somente números)', en: 'CPF (numbers only)', es: 'CPF (solo números)' },
    'form.cep':        { pt: 'CEP',              en: 'Zip code',          es: 'Código postal' },
    'form.terms':      { pt: 'Aceito os termos de uso', en: 'I accept the terms of use', es: 'Acepto los términos de uso' },

    /* ── footer ─────────────────────────────────────────── */
    'footer.copy':    { pt: '© 2026 FitCrew. Todos os direitos reservados.', en: '© 2026 FitCrew. All rights reserved.', es: '© 2026 FitCrew. Todos los derechos reservados.' },
    'footer.privacy': { pt: 'Política de Privacidade', en: 'Privacy Policy',   es: 'Política de Privacidad' },
    'footer.terms':   { pt: 'Termos de Serviço',       en: 'Terms of Service', es: 'Términos de Servicio' },
    'footer.faq':     { pt: 'FAQ',                     en: 'FAQ',              es: 'Preguntas Frecuentes' },

    /* ── index ──────────────────────────────────────────── */
    'index.why.title': {
        pt: 'POR QUE SE INSCREVER?',
        en: 'WHY SIGN UP?',
        es: '¿POR QUÉ INSCRIBIRSE?'
    },
    'index.why.desc': {
        pt: 'Atualmente, a rotina de exercícios físicos deixou de ser apenas uma questão de estética para tornar-se sinônimo de saúde e qualidade de vida. Entretanto, alguns experientes dificuldades para encontrar o espaço ou, até mesmo, a disposição adequada de exercitá-lo. Nessas situações, o FitCrew é a melhor alternativa para quem deseja inverter seu paradigma com o exercício.',
        en: 'Today, physical exercise has gone beyond aesthetics to become a synonym for health and quality of life. However, some people struggle to find the right space or motivation to work out. In these situations, FitCrew is the best alternative for those who want to change their relationship with exercise.',
        es: 'Hoy en día, la rutina de ejercicio físico ha dejado de ser solo una cuestión estética para convertirse en sinónimo de salud y calidad de vida. Sin embargo, algunas personas tienen dificultades para encontrar el espacio adecuado. En estas situaciones, FitCrew es la mejor alternativa para quienes desean cambiar su relación con el ejercicio.'
    },
    'index.why.btn': { pt: 'VEJA MAIS', en: 'LEARN MORE', es: 'VER MÁS' },
    'index.mod.aerobico':   { pt: 'AERÓBICO',      en: 'AEROBICS',      es: 'AERÓBICO' },
    'index.mod.musculacao': { pt: 'MUSCULAÇÃO',    en: 'WEIGHT TRAINING', es: 'MUSCULACIÓN' },
    'index.mod.natacao':    { pt: 'NATAÇÃO',        en: 'SWIMMING',      es: 'NATACIÓN' },
    'index.mod.marciais':   { pt: 'ARTES MARCIAIS', en: 'MARTIAL ARTS',  es: 'ARTES MARCIALES' },
    'index.mod.fitdance':   { pt: 'FITDANCE',       en: 'FITDANCE',      es: 'FITDANCE' },
    'index.mod.meditacao':  { pt: 'MEDITAÇÃO',      en: 'MEDITATION',    es: 'MEDITACIÓN' },

    /* ── categorias musculares ──────────────────────────── */
    'index.categories.title':    { pt: 'Treine cada músculo do seu corpo',            en: 'Train every muscle in your body',              es: 'Entrena cada músculo de tu cuerpo' },
    'index.categories.subtitle': { pt: '1.321 exercícios com GIF para cada grupo muscular', en: '1,321 GIF exercises for every muscle group', es: '1.321 ejercicios con GIF para cada grupo muscular' },
    'index.cat.peito':     { pt: 'Peito',     en: 'Chest',     es: 'Pecho' },
    'index.cat.costas':    { pt: 'Costas',    en: 'Back',      es: 'Espalda' },
    'index.cat.pernas':    { pt: 'Pernas',    en: 'Legs',      es: 'Piernas' },
    'index.cat.ombros':    { pt: 'Ombros',    en: 'Shoulders', es: 'Hombros' },
    'index.cat.biceps':    { pt: 'Bíceps',    en: 'Biceps',    es: 'Bíceps' },
    'index.cat.triceps':   { pt: 'Tríceps',   en: 'Triceps',   es: 'Tríceps' },
    'index.cat.core':      { pt: 'Core',      en: 'Core',      es: 'Core' },
    'index.cat.cardio':    { pt: 'Cardio',    en: 'Cardio',    es: 'Cardio' },
    'index.cat.gluteos':   { pt: 'Glúteos',   en: 'Glutes',    es: 'Glúteos' },
    'index.cat.antebraco': { pt: 'Antebraço', en: 'Forearm',   es: 'Antebrazo' },
    'index.cat.pescoco':   { pt: 'Pescoço',   en: 'Neck',      es: 'Cuello' },

    'index.plans.title': {
        pt: 'TREINO INTELIGENTE. IA PERSONALIZADA. DO SEU JEITO.',
        en: 'SMART TRAINING. PERSONALIZED AI. YOUR WAY.',
        es: 'ENTRENAMIENTO INTELIGENTE. IA PERSONALIZADA. A TU MANERA.'
    },
    'index.plans.desc': {
        pt: 'Com o FitCrew, você treina com inteligência artificial ao seu lado: planos de treino, dieta e acompanhamento personalizados. A gente cuida da tecnologia, você cuida da evolução. Conheça nossos planos e encontre o que combina com sua rotina.',
        en: 'With FitCrew, you train with artificial intelligence by your side: personalized workout plans, diet, and tracking. We handle the technology, you handle the progress. Explore our plans and find the one that fits your routine.',
        es: 'Con FitCrew, entrenas con inteligencia artificial a tu lado: planes de entrenamiento, dieta y seguimiento personalizados. Nosotros nos encargamos de la tecnología, tú del progreso. Conoce nuestros planes y encuentra el que se adapta a tu rutina.'
    },
    'index.plans.btn': { pt: 'VER PLANOS', en: 'SEE PLANS', es: 'VER PLANES' },

    /* ── index — números de impacto ─────────────────────── */
    'index.impact.exercises': { pt: 'Exercícios disponíveis', en: 'Exercises available', es: 'Ejercicios disponibles' },
    'index.impact.gifs':      { pt: 'GIFs de execução',       en: 'Execution GIFs',      es: 'GIFs de ejecución' },
    'index.impact.langs':     { pt: 'Idiomas suportados',     en: 'Languages supported', es: 'Idiomas disponibles' },
    'index.impact.ai':        { pt: 'Treinadora integrada',   en: 'Integrated trainer',  es: 'Entrenadora integrada' },

    /* ── index — IA treinadora ──────────────────────────── */
    'index.ai.badge':   { pt: '✦ Inteligência Artificial', en: '✦ Artificial Intelligence', es: '✦ Inteligencia Artificial' },
    'index.ai.title':   { pt: 'Seu personal trainer está no app', en: 'Your personal trainer is in the app', es: 'Tu entrenador personal está en la app' },
    'index.ai.desc':    {
        pt: 'A IA do FitCrew analisa seu perfil, objetivos e histórico para criar planos de treino e dieta 100% personalizados. Basta conversar.',
        en: 'FitCrew AI analyzes your profile, goals and history to create 100% personalized workout and diet plans. Just chat.',
        es: 'La IA de FitCrew analiza tu perfil, objetivos e historial para crear planes de entrenamiento y dieta 100% personalizados. Solo conversa.'
    },
    'index.ai.bullet1': { pt: 'Plano de treino gerado em segundos',        en: 'Workout plan generated in seconds',        es: 'Plan de entrenamiento generado en segundos' },
    'index.ai.bullet2': { pt: 'Dieta adaptada ao seu objetivo',             en: 'Diet adapted to your goal',                es: 'Dieta adaptada a tu objetivo' },
    'index.ai.bullet3': { pt: 'Avaliação corporal por foto (plano Black)',  en: 'Photo body assessment (Black plan)',        es: 'Evaluación corporal por foto (plan Black)' },
    'index.ai.btn':     { pt: 'Conhecer planos →', en: 'Explore plans →', es: 'Ver planes →' },
    'index.ai.photo':   { pt: 'Foto do app — IA', en: 'App screenshot — AI', es: 'Foto de la app — IA' },

    /* ── index — como funciona ──────────────────────────── */
    'index.how.title':        { pt: 'Do zero ao treino em 3 passos',         en: 'From zero to workout in 3 steps',          es: 'Del cero al entrenamiento en 3 pasos' },
    'index.how.step1.title':  { pt: 'Crie seu perfil',                        en: 'Create your profile',                      es: 'Crea tu perfil' },
    'index.how.step1.desc':   { pt: 'Informe seus objetivos, nível de condicionamento e preferências', en: 'Enter your goals, fitness level and preferences', es: 'Ingresa tus objetivos, nivel físico y preferencias' },
    'index.how.step2.title':  { pt: 'Converse com a IA',                      en: 'Chat with the AI',                         es: 'Conversa con la IA' },
    'index.how.step2.desc':   { pt: 'Peça seu treino ou dieta. A IA monta tudo personalizado pra você', en: 'Ask for your workout or diet. The AI builds everything personalized for you', es: 'Pide tu entrenamiento o dieta. La IA lo arma todo personalizado para ti' },
    'index.how.step3.title':  { pt: 'Execute e evolua',                        en: 'Execute and evolve',                       es: 'Ejecuta y evoluciona' },
    'index.how.step3.desc':   { pt: 'Siga o treino com GIFs, registre suas cargas e acompanhe seu progresso', en: 'Follow the workout with GIFs, log your weights and track your progress', es: 'Sigue el entrenamiento con GIFs, registra tus cargas y monitorea tu progreso' },

    /* ── index — execução de treino ─────────────────────── */
    'index.exec.badge':   { pt: '✦ Execução guiada', en: '✦ Guided execution', es: '✦ Ejecución guiada' },
    'index.exec.title':   { pt: 'Treine com GIF, séries e cronômetro', en: 'Train with GIF, sets and timer', es: 'Entrena con GIF, series y cronómetro' },
    'index.exec.desc':    {
        pt: 'Cada exercício com GIF demonstrativo, contagem de séries, registro de carga e timer de descanso. Tudo numa tela só.',
        en: 'Every exercise with a demonstration GIF, set count, weight log and rest timer. All in one screen.',
        es: 'Cada ejercicio con GIF demostrativo, conteo de series, registro de carga y temporizador de descanso. Todo en una pantalla.'
    },
    'index.exec.bullet1': { pt: 'GIF animado para cada exercício',           en: 'Animated GIF for each exercise',           es: 'GIF animado para cada ejercicio' },
    'index.exec.bullet2': { pt: 'Timer de descanso automático',               en: 'Automatic rest timer',                     es: 'Temporizador de descanso automático' },
    'index.exec.bullet3': { pt: 'Registro de carga e histórico de evolução', en: 'Weight log and progress history',           es: 'Registro de carga e historial de evolución' },
    'index.exec.photo':   { pt: 'Foto — Execução de treino', en: 'Screenshot — Workout execution', es: 'Foto — Ejecución de entrenamiento' },

    /* ── sobre (about) ──────────────────────────────────── */

    /* hero editorial */
    'about.hero.line1': { pt: 'Construído por', en: 'Built by', es: 'Construido por' },
    'about.hero.line2': { pt: 'quem treina.', en: 'those who train.', es: 'quienes entrenan.' },
    'about.hero.sub.v2': {
        pt: 'FitCrew é uma plataforma de treino inteligente que usa IA para personalizar cada aspecto da sua evolução física. Sem achismo. Sem plano genérico.',
        en: 'FitCrew is an intelligent training platform that uses AI to personalize every aspect of your physical progress. No guesswork. No generic plan.',
        es: 'FitCrew es una plataforma de entrenamiento inteligente que usa IA para personalizar cada aspecto de tu evolución física. Sin suposiciones. Sin plan genérico.'
    },

    /* manifesto */
    'about.history.title': { pt: 'Nossa História', en: 'Our Story', es: 'Nuestra Historia' },
    'about.manifesto.p1': {
        pt: 'O FitCrew nasceu dentro de uma sala de aula como projeto de conclusão de curso, e cresceu para além disso. Desde o início, a ideia era simples: e se a tecnologia pudesse fazer o que um personal trainer faz, mas acessível para qualquer pessoa?',
        en: 'FitCrew was born inside a classroom as a graduation project, and grew beyond that. From the start, the idea was simple: what if technology could do what a personal trainer does, but accessible to anyone?',
        es: 'FitCrew nació dentro de un aula como proyecto de fin de carrera, y creció más allá de eso. Desde el principio, la idea era simple: ¿y si la tecnología pudiera hacer lo que hace un entrenador personal, pero accesible para cualquier persona?'
    },
    'about.manifesto.p2': {
        pt: 'Hoje, a plataforma combina inteligência artificial, execução guiada com GIFs, notificações inteligentes e histórico de evolução, tudo num app que roda no celular sem precisar instalar nada. O FitCrew é um produto real, construído com stack real, para pessoas reais que querem resultado.',
        en: 'Today, the platform combines artificial intelligence, GIF-guided exercise execution, smart notifications and progress history, all in an app that runs on your phone without installing anything. FitCrew is a real product, built with a real stack, for real people who want results.',
        es: 'Hoy, la plataforma combina inteligencia artificial, ejecución guiada con GIFs, notificaciones inteligentes e historial de evolución, todo en una app que funciona en el celular sin necesidad de instalar nada. FitCrew es un producto real, construido con stack real, para personas reales que quieren resultados.'
    },

    /* números */
    'about.num.exercises': { pt: 'exercícios catalogados', en: 'catalogued exercises', es: 'ejercicios catalogados' },
    'about.num.gifs':      { pt: 'GIFs de execução',       en: 'execution GIFs',       es: 'GIFs de ejecución' },
    'about.num.langs':     { pt: 'idiomas suportados',     en: 'languages supported',  es: 'idiomas disponibles' },
    'about.num.version':   { pt: 'versão atual',           en: 'current version',      es: 'versión actual' },

    /* stack */
    'about.stack.label': { pt: 'STACK & TECNOLOGIA', en: 'STACK & TECHNOLOGY', es: 'STACK Y TECNOLOGÍA' },
    'about.stack.title': {
        pt: 'Cada decisão técnica foi intencional.',
        en: 'Every technical decision was intentional.',
        es: 'Cada decisión técnica fue intencional.'
    },

    /* trainer */
    'about.trainer.label': { pt: 'PERSONAL TRAINER PARCEIRO', en: 'PARTNER PERSONAL TRAINER', es: 'PERSONAL TRAINER ASOCIADO' },
    'about.trainer.role':  { pt: 'Especialista em Performance Física', en: 'Physical Performance Specialist', es: 'Especialista en Rendimiento Físico' },
    'about.trainer.bio': {
        pt: 'Mathias é o parceiro de performance física do FitCrew. Com experiência em musculação e alto rendimento, ele garante que cada protocolo gerado pela IA esteja alinhado com as melhores práticas do mercado fitness.',
        en: 'Mathias is FitCrew\'s physical performance partner. With experience in bodybuilding and high performance, he ensures every AI-generated protocol aligns with the best practices in the fitness industry.',
        es: 'Mathias es el socio de rendimiento físico de FitCrew. Con experiencia en musculación y alto rendimiento, garantiza que cada protocolo generado por la IA esté alineado con las mejores prácticas del mercado fitness.'
    },

    /* cta editorial */
    'about.cta.line1': { pt: 'Pronto para', en: 'Ready to', es: '¿Listo para' },
    'about.cta.line2': { pt: 'evoluir de verdade?', en: 'evolve for real?', es: 'evolucionar de verdad?' },
    'about.cta.sub.v2': {
        pt: 'Crie sua conta e deixa a IA montar seu primeiro treino agora.',
        en: 'Create your account and let the AI build your first workout now.',
        es: 'Crea tu cuenta y deja que la IA arme tu primer entrenamiento ahora.'
    },
    'about.history.desc': {
        pt: 'Fundada com o objetivo de transformar a forma como as pessoas encaram o exercício físico, a FitCrew nasceu da ideia de unir tecnologia, inteligência artificial e motivação. Queremos que cada treino seja uma experiência única e personalizada, que inspire nossos usuários a cuidar da saúde e se superar todos os dias.',
        en: 'Founded with the goal of transforming how people approach physical exercise, FitCrew was born from the idea of uniting technology, artificial intelligence and motivation. We want every workout to be a unique, personalized experience that inspires our users to take care of their health and surpass themselves every day.',
        es: 'Fundada con el objetivo de transformar la forma en que las personas abordan el ejercicio físico, FitCrew nació de la idea de unir tecnología, inteligencia artificial y motivación. Queremos que cada entrenamiento sea una experiencia única y personalizada que inspire a nuestros usuarios a cuidar su salud y superarse cada día.'
    },

    /* ── about — hero ───────────────────────────────────── */
    'about.hero.title': {
        pt: 'Construído para quem leva o treino a sério',
        en: 'Built for those who take training seriously',
        es: 'Construido para quienes toman el entrenamiento en serio'
    },
    'about.hero.desc': {
        pt: 'O FitCrew nasceu da ideia de que tecnologia e saúde deveriam andar juntas. Somos uma plataforma de treino inteligente que usa IA para personalizar cada aspecto da sua jornada fitness.',
        en: 'FitCrew was born from the idea that technology and health should go hand in hand. We are a smart training platform that uses AI to personalize every aspect of your fitness journey.',
        es: 'FitCrew nació de la idea de que la tecnología y la salud deberían ir de la mano. Somos una plataforma de entrenamiento inteligente que usa IA para personalizar cada aspecto de tu jornada fitness.'
    },

    'about.mission.title': { pt: 'Missão',  en: 'Mission', es: 'Misión' },
    'about.mission.desc': {
        pt: 'Proporcionar a cada usuário uma experiência de treino inteligente e personalizada, combinando tecnologia, IA e motivação para transformar a saúde e o bem-estar no dia a dia.',
        en: 'Provide each user with an intelligent, personalized training experience, combining technology, AI and motivation to transform health and well-being every day.',
        es: 'Proporcionar a cada usuario una experiencia de entrenamiento inteligente y personalizada, combinando tecnología, IA y motivación para transformar la salud y el bienestar cotidiano.'
    },
    'about.vision.title': { pt: 'Visão', en: 'Vision', es: 'Visión' },
    'about.vision.desc': {
        pt: 'Ser a plataforma de referência em treino assistido por IA no Brasil, tornando o acompanhamento profissional acessível para qualquer pessoa, em qualquer lugar.',
        en: 'To be the leading AI-assisted training platform in Brazil, making professional coaching accessible to anyone, anywhere.',
        es: 'Ser la plataforma de referencia en entrenamiento asistido por IA en Brasil, haciendo que el acompañamiento profesional sea accesible para cualquier persona, en cualquier lugar.'
    },
    'about.values.title': { pt: 'Valores', en: 'Values', es: 'Valores' },
    'about.values.desc': {
        pt: 'Compromisso, Flexibilidade, Inovação, Respeito e Paixão pelo exercício físico.',
        en: 'Commitment, Flexibility, Innovation, Respect and Passion for physical exercise.',
        es: 'Compromiso, Flexibilidad, Innovación, Respeto y Pasión por el ejercicio físico.'
    },
    'about.team.title': { pt: 'Quem está por trás do FitCrew', en: 'Who is behind FitCrew', es: 'Quiénes están detrás de FitCrew' },

    /* ── about — tecnologia ─────────────────────────────── */
    'about.tech.title':    { pt: 'Tecnologia de ponta, resultado real', en: 'Cutting-edge technology, real results', es: 'Tecnología de punta, resultados reales' },
    'about.tech.subtitle': {
        pt: 'Cada feature do FitCrew foi construída com as melhores ferramentas disponíveis',
        en: 'Every FitCrew feature was built with the best tools available',
        es: 'Cada feature de FitCrew fue construida con las mejores herramientas disponibles'
    },
    'about.tech.groq.name':       { pt: 'Groq AI',     en: 'Groq AI',     es: 'Groq AI' },
    'about.tech.groq.desc':       { pt: 'IA ultra-rápida para geração de treinos e dietas',    en: 'Ultra-fast AI for workout and diet generation',       es: 'IA ultra-rápida para generación de entrenamientos y dietas' },
    'about.tech.cloudinary.name': { pt: 'Cloudinary',  en: 'Cloudinary',  es: 'Cloudinary' },
    'about.tech.cloudinary.desc': { pt: '235+ GIFs de exercícios otimizados',                  en: '235+ optimized exercise GIFs',                        es: '235+ GIFs de ejercicios optimizados' },
    'about.tech.push.name':       { pt: 'Web Push',    en: 'Web Push',    es: 'Web Push' },
    'about.tech.push.desc':       { pt: 'Notificações de treino, água e sono',                  en: 'Workout, water and sleep notifications',               es: 'Notificaciones de entrenamiento, agua y sueño' },
    'about.tech.pwa.name':        { pt: 'PWA',         en: 'PWA',         es: 'PWA' },
    'about.tech.pwa.desc':        { pt: 'Instale no celular, funciona offline',                  en: 'Install on mobile, works offline',                    es: 'Instala en el celular, funciona sin conexión' },
    'about.tech.mysql.name':      { pt: 'MySQL',       en: 'MySQL',       es: 'MySQL' },
    'about.tech.mysql.desc':      { pt: 'Histórico e evolução salvos com segurança',             en: 'History and progress saved securely',                 es: 'Historial y evolución guardados con seguridad' },
    'about.tech.i18n.name':       { pt: 'i18n',        en: 'i18n',        es: 'i18n' },
    'about.tech.i18n.desc':       { pt: 'Disponível em português, inglês e espanhol',            en: 'Available in Portuguese, English and Spanish',        es: 'Disponible en portugués, inglés y español' },

    /* ── about — equipe ─────────────────────────────────── */
    'about.team.mathias.role': { pt: 'Personal Trainer Certificado ✦ Parceiro Oficial', en: 'Certified Personal Trainer ✦ Official Partner', es: 'Personal Trainer Certificado ✦ Socio Oficial' },
    'about.team.mathias.bio':  {
        pt: 'Mathias é o especialista em performance física do FitCrew. Com anos de experiência em musculação e alto rendimento, ele garante que cada treino gerado pela IA esteja alinhado com as melhores práticas do mercado fitness.',
        en: 'Mathias is FitCrew\'s physical performance specialist. With years of experience in bodybuilding and high performance, he ensures every AI-generated workout aligns with the best practices in the fitness industry.',
        es: 'Mathias es el especialista en rendimiento físico de FitCrew. Con años de experiencia en musculación y alto rendimiento, garantiza que cada entrenamiento generado por la IA esté alineado con las mejores prácticas del mercado fitness.'
    },
    'about.team.mathias.note': {
        pt: '* Mathias está em retiro espiritual e não atende mensagens no momento',
        en: '* Mathias is on a spiritual retreat and is not available for messages at this time',
        es: '* Mathias está en retiro espiritual y no atiende mensajes en este momento'
    },
    'about.team.davi.role': { pt: 'Fundador & Desenvolvedor Full Stack', en: 'Founder & Full Stack Developer', es: 'Fundador y Desarrollador Full Stack' },
    'about.team.davi.bio':  {
        pt: 'Responsável por toda a arquitetura, frontend, backend e identidade visual do FitCrew. Desenvolveu a plataforma do zero com Node.js, IA e muito café.',
        en: 'Responsible for FitCrew\'s full architecture, frontend, backend and visual identity. Built the platform from scratch with Node.js, AI and a lot of coffee.',
        es: 'Responsable de toda la arquitectura, frontend, backend e identidad visual de FitCrew. Desarrolló la plataforma desde cero con Node.js, IA y mucho café.'
    },
    'about.team.felippe.role': { pt: 'Co-fundador & Estratégia de Crescimento', en: 'Co-founder & Growth Strategy', es: 'Cofundador y Estrategia de Crecimiento' },
    'about.team.felippe.bio':  {
        pt: 'Responsável pela estratégia de tráfego pago e crescimento da plataforma.',
        en: 'Responsible for paid traffic strategy and platform growth.',
        es: 'Responsable de la estrategia de tráfico pago y el crecimiento de la plataforma.'
    },

    /* ── about — cta ────────────────────────────────────── */
    'about.cta.title': { pt: 'Pronto para treinar de verdade?', en: 'Ready to train for real?', es: '¿Listo para entrenar de verdad?' },
    'about.cta.desc':  {
        pt: 'Crie sua conta grátis e deixa a IA montar seu primeiro treino agora.',
        en: 'Create your free account and let the AI build your first workout now.',
        es: 'Crea tu cuenta gratis y deja que la IA arme tu primer entrenamiento ahora.'
    },
    'about.cta.btn': { pt: 'Começar agora →', en: 'Get started →', es: 'Empezar ahora →' },

    /* ── planos ─────────────────────────────────────────── */
    'plans.hero.title': {
        pt: 'PLANOS E PREÇOS DO GYMBROS',
        en: 'GYMBROS PLANS & PRICING',
        es: 'PLANES Y PRECIOS DE GYMBROS'
    },
    'plans.hero.desc': {
        pt: 'O maior site de saúde e bem-estar do mundo, com melhores preços acessíveis para todos',
        en: 'The world\'s largest health and wellness platform, with the best prices accessible to everyone',
        es: 'El mayor sitio de salud y bienestar del mundo, con los mejores precios accesibles para todos'
    },
    'plans.no_plan': {
        pt: 'Você ainda não possui um plano ativo. Escolha um plano para acessar a área do aluno.',
        en: 'You don\'t have an active plan yet. Choose a plan to access the member area.',
        es: 'Aún no tienes un plan activo. Elige un plan para acceder al área del alumno.'
    },
    'plans.gymbro.f1':  { pt: 'Treinos manuais + execução com GIFs', en: 'Manual workouts + GIF execution', es: 'Entrenamientos manuales + ejecución con GIFs' },
    'plans.gymbro.f2':  { pt: 'IA treinadora personalizada',     en: 'Personalized AI trainer',       es: 'IA entrenadora personalizada' },
    'plans.gymbro.f3':  { pt: 'Plano de treino gerado por IA',   en: 'AI-generated workout plan',     es: 'Plan de entrenamiento generado por IA' },
    'plans.gymbro.f4':  { pt: 'Plano de dieta gerado por IA',    en: 'AI-generated diet plan',        es: 'Plan de dieta generado por IA' },
    'plans.gymbro.f5':  { pt: 'Histórico completo de conversas IA', en: 'Full AI conversation history', es: 'Historial completo de conversaciones IA' },
    'plans.black.f1':   { pt: 'Tudo do GymBro',                  en: 'Everything in GymBro',          es: 'Todo lo del GymBro' },
    'plans.black.f2':   { pt: 'Avaliação corporal por foto (IA Vision)', en: 'Photo body assessment (AI Vision)', es: 'Evaluación corporal por foto (IA Vision)' },
    'plans.black.f3':   { pt: 'Personal trainer IA exclusivo',   en: 'Exclusive AI personal trainer', es: 'Personal trainer IA exclusivo' },
    'plans.black.f4':   { pt: 'Análise avançada de evolução corporal', en: 'Advanced body progress analysis', es: 'Análisis avanzado de evolución corporal' },
    'plans.black.f5':   { pt: 'Suporte prioritário',             en: 'Priority support',              es: 'Soporte prioritario' },
    'plans.btn.subscribe': { pt: 'Assinar agora', en: 'Subscribe now', es: 'Suscribirse ahora' },
    'plans.price.month':   { pt: '/mês',          en: '/month',        es: '/mes' },

    /* ── IA — disclaimer ─────────────────────────────── */
    'ai.disclaimer.title': {
        pt: 'Aviso importante sobre a IA',
        en: 'Important notice about AI',
        es: 'Aviso importante sobre la IA'
    },
    'ai.disclaimer.text': {
        pt: 'As recomendações geradas pela IA têm caráter informativo e educacional. Elas não substituem a orientação de um profissional de saúde habilitado. Consulte sempre um especialista antes de iniciar qualquer programa de treino ou dieta.',
        en: 'AI-generated recommendations are informational and educational in nature. They do not replace guidance from a licensed healthcare professional. Always consult a specialist before starting any workout or diet program.',
        es: 'Las recomendaciones generadas por la IA son de carácter informativo y educacional. No sustituyen la orientación de un profesional de salud habilitado. Consulte siempre a un especialista antes de iniciar cualquier programa de entrenamiento o dieta.'
    },

    /* ── treinos ─────────────────────────────────────── */
    'treinos.title':          { pt: 'Meus Treinos',              en: 'My Workouts',               es: 'Mis Entrenamientos' },
    'treinos.subtitle':       { pt: 'Registre suas sessões e acompanhe seu progresso', en: 'Log your sessions and track your progress', es: 'Registra tus sesiones y sigue tu progreso' },
    'treinos.checkin.done':   { pt: 'Presença registrada!',      en: 'Attendance logged!',         es: '¡Asistencia registrada!' },
    'treinos.checkin.title':  { pt: 'Registrar presença',        en: 'Log attendance',            es: 'Registrar asistencia' },
    'treinos.checkin.sub':    { pt: 'Você ainda não registrou presença hoje', en: 'You haven\'t logged attendance today', es: 'No has registrado asistencia hoy' },
    'treinos.checkin.streak': { pt: 'Começa sua sequência hoje', en: 'Start your streak today',   es: 'Comienza tu racha hoy' },
    'treinos.checkin.btn':    { pt: 'Registrar presença hoje',   en: 'Log attendance today',      es: 'Registrar asistencia hoy' },
    'treinos.plans.title':    { pt: 'Seus Planos de Treino',     en: 'Your Workout Plans',        es: 'Tus Planes de Entrenamiento' },
    'treinos.plans.new':      { pt: 'Novo treino',               en: 'New workout',               es: 'Nuevo entrenamiento' },
    'treinos.start':          { pt: 'Iniciar treino',            en: 'Start workout',             es: 'Iniciar entrenamiento' },

    /* ── dashboard ──────────────────────────────────── */
    'dashboard.welcome':           { pt: 'Bem-vindo',                     en: 'Welcome',               es: 'Bienvenido' },
    'dashboard.subtitle':          { pt: 'Acompanhe seu progresso, treinos e planos', en: 'Track your progress, workouts and plans', es: 'Sigue tu progreso, entrenamientos y planes' },
    'dashboard.weekly':            { pt: 'Treinos esta semana',           en: 'Workouts this week',    es: 'Entrenamientos esta semana' },
    'dashboard.achievements':      { pt: 'Conquistas',                   en: 'Achievements',          es: 'Logros' },
    'dashboard.goal':              { pt: 'Meta semanal',                  en: 'Weekly goal',           es: 'Meta semanal' },
    'dashboard.goal.title':        { pt: 'Meta Semanal',                  en: 'Weekly Goal',           es: 'Meta Semanal' },
    'dashboard.recent':            { pt: 'Atividades Recentes',           en: 'Recent Activities',     es: 'Actividades Recientes' },
    'dashboard.viewall':           { pt: 'Ver todos',                    en: 'View all',              es: 'Ver todos' },
    'dashboard.streak':            { pt: 'Sequência atual',               en: 'Current streak',       es: 'Racha actual' },
    'dashboard.days':              { pt: 'dias',                          en: 'days',                 es: 'días' },
    'dashboard.monthly':           { pt: 'Treinos este mês',             en: 'Workouts this month',  es: 'Entrenamientos este mes' },
    'dashboard.lastactivity':      { pt: 'Última atividade',             en: 'Last activity',        es: 'Última actividad' },
    'dashboard.actions.treinos':   { pt: 'Ver planilha de treinos',       en: 'View workout plan',    es: 'Ver plan de entrenamiento' },
    'dashboard.actions.evolucao':  { pt: 'Acompanhe seus resultados',    en: 'Track your results',   es: 'Sigue tus resultados' },

    /* ── config ─────────────────────────────────────── */
    'config.title':          { pt: 'Configurações',           en: 'Settings',                es: 'Configuración' },
    'config.subtitle':       { pt: 'Gerencie seu perfil, segurança e preferências', en: 'Manage your profile, security and preferences', es: 'Gestiona tu perfil, seguridad y preferencias' },
    'config.profile':        { pt: 'Perfil',                  en: 'Profile',                 es: 'Perfil' },
    'config.security':       { pt: 'Segurança',               en: 'Security',                es: 'Seguridad' },
    'config.prefs':          { pt: 'Preferências',            en: 'Preferences',             es: 'Preferencias' },
    'config.notifications':  { pt: 'Notificações',            en: 'Notifications',           es: 'Notificaciones' },
    'config.reminders':      { pt: 'Lembretes',               en: 'Reminders',               es: 'Recordatorios' },
    'config.water':          { pt: 'Lembrete de água',        en: 'Water reminder',          es: 'Recordatorio de agua' },
    'config.sleep':          { pt: 'Lembrete de sono',        en: 'Sleep reminder',          es: 'Recordatorio de sueño' },
    'config.interval':       { pt: 'Intervalo de lembretes',  en: 'Reminder interval',       es: 'Intervalo de recordatorios' },
    'config.save.changes':   { pt: 'Salvar alterações',       en: 'Save changes',            es: 'Guardar cambios' },
    'config.save.photo':     { pt: 'Salvar foto',             en: 'Save photo',              es: 'Guardar foto' },
    'config.change.pass':    { pt: 'Alterar senha',           en: 'Change password',         es: 'Cambiar contraseña' },
    'config.danger':         { pt: 'Zona de perigo',          en: 'Danger zone',             es: 'Zona de peligro' },
    'config.logout':         { pt: 'Sair da conta',           en: 'Log out',                 es: 'Cerrar sesión' },
    'config.save.btn':       { pt: 'Salvar',                  en: 'Save',                    es: 'Guardar' },
    'config.save.reminders': { pt: 'Salvar lembretes',        en: 'Save reminders',          es: 'Guardar recordatorios' },

    /* ── chat IA ─────────────────────────────────────── */
    'chat.title':         { pt: 'Personal Trainer IA',     en: 'AI Personal Trainer',     es: 'Entrenador Personal IA' },
    'chat.subtitle':      { pt: 'Tire suas dúvidas sobre treinos, exercícios, nutrição e muito mais', en: 'Get answers about workouts, exercises, nutrition and more', es: 'Resuelve tus dudas sobre entrenamientos, ejercicios, nutrición y más' },
    'chat.placeholder':   { pt: 'Digite sua mensagem...', en: 'Type your message...',     es: 'Escribe tu mensaje...' },
    'chat.new':           { pt: 'Nova conversa',          en: 'New conversation',         es: 'Nueva conversación' },
    'chat.conversations': { pt: 'Conversas',              en: 'Conversations',            es: 'Conversaciones' },
    'chat.send':          { pt: 'Enviar',                 en: 'Send',                     es: 'Enviar' },

    /* ── avaliação corporal ──────────────────────────── */
    'body.title':        { pt: 'Avaliação Corporal com IA',  en: 'AI Body Assessment',  es: 'Evaluación Corporal con IA' },
    'body.subtitle':     { pt: 'Envie suas fotos e receba uma análise estimativa de composição corporal', en: 'Send your photos and receive an estimated body composition analysis', es: 'Envía tus fotos y recibe un análisis estimativo de composición corporal' },
    'body.photos.title': { pt: 'Enviar Fotos',               en: 'Upload Photos',       es: 'Subir Fotos' },
    'body.photos.desc':  { pt: 'Foto frontal obrigatória — lateral e posterior opcionais', en: 'Front photo required — side and back optional', es: 'Foto frontal obligatoria — lateral y posterior opcionales' },
    'body.photo.front':  { pt: 'Foto Frontal',               en: 'Front Photo',         es: 'Foto Frontal' },
    'body.photo.side':   { pt: 'Foto Lateral',               en: 'Side Photo',          es: 'Foto Lateral' },
    'body.photo.back':   { pt: 'Foto Posterior',             en: 'Back Photo',          es: 'Foto Posterior' },
    'body.required':     { pt: '* obrigatório',              en: '* required',          es: '* obligatorio' },
    'body.optional':     { pt: 'opcional',                   en: 'optional',            es: 'opcional' },
    'body.analyze':      { pt: 'Analisar',                   en: 'Analyze',             es: 'Analizar' },

    /* ── meu plano ───────────────────────────────────── */
    'myplan.title':    { pt: 'Meu Plano',       en: 'My Plan',        es: 'Mi Plan' },
    'myplan.subtitle': { pt: 'Gerencie sua assinatura, veja benefícios e compare com outros planos.', en: 'Manage your subscription, view benefits and compare plans.', es: 'Gestiona tu suscripción, ve beneficios y compara planes.' },
    'myplan.active':   { pt: 'Plano ativo',     en: 'Active plan',    es: 'Plan activo' },
    'myplan.others':   { pt: 'Outros Planos Disponíveis', en: 'Other Available Plans', es: 'Otros Planes Disponibles' },
    'myplan.renew':    { pt: 'Seu plano renova automaticamente na data acima.', en: 'Your plan renews automatically on the date above.', es: 'Tu plan se renueva automáticamente en la fecha indicada.' },
    'myplan.none':     { pt: 'Sem plano ativo', en: 'No active plan', es: 'Sin plan activo' },

    /* ── suporte ─────────────────────────────────────── */
    'support.title':     { pt: 'Central de Suporte',   en: 'Support Center',    es: 'Centro de Soporte' },
    'support.subtitle':  { pt: 'Abra chamados e acompanhe o status do seu atendimento', en: 'Open tickets and track your support status', es: 'Abre tickets y sigue el estado de tu atención' },
    'support.new':       { pt: 'Abrir Novo Chamado',   en: 'Open New Ticket',   es: 'Abrir Nuevo Ticket' },
    'support.subject':   { pt: 'Assunto *',            en: 'Subject *',         es: 'Asunto *' },
    'support.send':      { pt: 'Enviar Chamado',       en: 'Submit Ticket',     es: 'Enviar Ticket' },
    'support.mytickets': { pt: 'Meus Chamados',        en: 'My Tickets',        es: 'Mis Tickets' },
    'support.desc':      { pt: 'Descrição *',          en: 'Description *',     es: 'Descripción *' },

    /* ── perfil IMC ──────────────────────────────────── */
    'imc.title':       { pt: 'Meu Perfil IMC',  en: 'My BMI Profile', es: 'Mi Perfil IMC' },
    'imc.subtitle':    { pt: 'Preencha seu perfil para receber orientações personalizadas do GymBot', en: 'Fill in your profile to receive personalized guidance from GymBot', es: 'Completa tu perfil para recibir orientaciones personalizadas del GymBot' },
    'imc.weight':      { pt: 'Peso (kg)',        en: 'Weight (kg)',    es: 'Peso (kg)' },
    'imc.height':      { pt: 'Altura (cm)',      en: 'Height (cm)',    es: 'Altura (cm)' },
    'imc.save':        { pt: 'Salvar Perfil',    en: 'Save Profile',   es: 'Guardar Perfil' },
    'imc.step.next':   { pt: 'Avançar',          en: 'Next',           es: 'Siguiente' },
    'imc.step.back':   { pt: 'Voltar',           en: 'Back',           es: 'Atrás' }
};

let currentLang = localStorage.getItem('gymbros_lang') || getCookieLang() || 'pt';
if (!VALID_LANGS.includes(currentLang)) currentLang = 'pt';

function updateLangButtons(lang) {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;
}

function setElementText(el, text) {
    const hasElementChild = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
    const textNodes = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE);
    if (textNodes.length > 0) {
        textNodes[textNodes.length - 1].textContent = hasElementChild ? ' ' + text : text;
    } else {
        el.appendChild(document.createTextNode(text));
    }
}

function applyDictionary(lang) {
    document.querySelectorAll('[data-i18n], [data-translate]').forEach(el => {
        const key = el.dataset.i18n || el.dataset.translate;
        const translation = dictionary[key]?.[lang];
        if (!translation) return;
        setElementText(el, translation);
    });
}

function applyDictionaryAttributes(lang) {
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const t = dictionary[el.dataset.i18nPlaceholder]?.[lang];
        if (t) el.setAttribute('placeholder', t);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const t = dictionary[el.dataset.i18nTitle]?.[lang];
        if (t) el.setAttribute('title', t);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const t = dictionary[el.dataset.i18nAriaLabel]?.[lang];
        if (t) el.setAttribute('aria-label', t);
    });
}

function translatePage(lang) {
    applyDictionary(lang);
    applyDictionaryAttributes(lang);
}

function switchLanguage(lang) {
    if (!VALID_LANGS.includes(lang) || lang === currentLang) return;
    localStorage.setItem('gymbros_lang', lang);
    window.location.href = '/lang/' + lang;
}

window.changeLang        = switchLanguage;
window.switchLanguage    = switchLanguage;
window.translatePage     = translatePage;
window.applyDictionary   = applyDictionary;
window.__t = function(key) {
    return (dictionary[key] && dictionary[key][currentLang]) || key;
};

document.addEventListener('DOMContentLoaded', () => {
    setCookieLang(currentLang);
    updateLangButtons(currentLang);
    translatePage(currentLang);

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => switchLanguage(btn.dataset.lang));
    });
});
