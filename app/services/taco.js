'use strict';

// TACO — Tabela Brasileira de Composição de Alimentos (UNICAMP, 4ª ed.)
// Valores por 100g. Fonte: NEPA/UNICAMP.
const TACO = [
    // CEREAIS E DERIVADOS
    { id:'t001', nome:'Arroz, branco, cozido',           kcal:128, proteina:2.5,  carbs:28.1, gordura:0.2, fibra:1.6 },
    { id:'t002', nome:'Arroz, integral, cozido',         kcal:124, proteina:2.6,  carbs:25.8, gordura:1.0, fibra:2.7 },
    { id:'t003', nome:'Macarrão, cozido',                kcal:131, proteina:4.9,  carbs:26.0, gordura:0.8, fibra:1.8 },
    { id:'t004', nome:'Macarrão integral, cozido',       kcal:124, proteina:5.3,  carbs:23.2, gordura:1.0, fibra:3.5 },
    { id:'t005', nome:'Aveia, flocos',                   kcal:394, proteina:13.9, carbs:66.6, gordura:8.5, fibra:9.1 },
    { id:'t006', nome:'Pão, francês',                    kcal:300, proteina:8.0,  carbs:58.6, gordura:3.1, fibra:2.3 },
    { id:'t007', nome:'Pão, integral',                   kcal:253, proteina:8.1,  carbs:46.3, gordura:3.4, fibra:5.7 },
    { id:'t008', nome:'Farinha de trigo, enriquecida',   kcal:360, proteina:9.8,  carbs:75.1, gordura:1.4, fibra:2.3 },
    { id:'t009', nome:'Tapioca, hidratada',              kcal:98,  proteina:0.1,  carbs:24.4, gordura:0.0, fibra:0.9 },
    { id:'t010', nome:'Cuscuz de milho, cozido',         kcal:93,  proteina:2.4,  carbs:20.2, gordura:0.6, fibra:1.3 },
    { id:'t011', nome:'Fubá de milho, cru',              kcal:353, proteina:7.8,  carbs:74.2, gordura:2.1, fibra:4.4 },
    { id:'t012', nome:'Granola',                         kcal:387, proteina:7.8,  carbs:64.4, gordura:12.1,fibra:8.5 },
    { id:'t013', nome:'Biscoito, água e sal',            kcal:444, proteina:9.4,  carbs:68.6, gordura:15.2,fibra:1.9 },

    // LEGUMINOSAS
    { id:'t020', nome:'Feijão, preto, cozido',           kcal:77,  proteina:4.5,  carbs:14.0, gordura:0.5, fibra:8.4 },
    { id:'t021', nome:'Feijão, carioca, cozido',         kcal:76,  proteina:4.8,  carbs:13.6, gordura:0.5, fibra:8.5 },
    { id:'t022', nome:'Feijão, branco, cozido',          kcal:112, proteina:8.0,  carbs:19.0, gordura:0.8, fibra:5.4 },
    { id:'t023', nome:'Lentilha, cozida',                kcal:95,  proteina:6.3,  carbs:18.0, gordura:0.5, fibra:3.7 },
    { id:'t024', nome:'Grão-de-bico, cozido',            kcal:166, proteina:8.9,  carbs:27.4, gordura:2.7, fibra:6.0 },
    { id:'t025', nome:'Soja, cozida',                    kcal:141, proteina:14.0, carbs:11.4, gordura:6.0, fibra:9.0 },
    { id:'t026', nome:'Ervilha, cozida',                 kcal:95,  proteina:6.4,  carbs:15.8, gordura:0.5, fibra:5.7 },
    { id:'t027', nome:'Ervilha, congelada, cozida',      kcal:77,  proteina:5.2,  carbs:13.7, gordura:0.3, fibra:5.1 },

    // CARNES BOVINAS
    { id:'t030', nome:'Carne bovina, patinho, cozido',   kcal:219, proteina:32.0, carbs:0.0,  gordura:9.9, fibra:0.0 },
    { id:'t031', nome:'Carne bovina, alcatra, grelhada', kcal:248, proteina:31.1, carbs:0.0,  gordura:13.5,fibra:0.0 },
    { id:'t032', nome:'Carne bovina, filé mignon, grelhado', kcal:244, proteina:33.0, carbs:0.0, gordura:12.2, fibra:0.0 },
    { id:'t033', nome:'Carne bovina, moída, refogada',   kcal:287, proteina:27.3, carbs:0.0,  gordura:19.2,fibra:0.0 },
    { id:'t034', nome:'Carne bovina, picanha, grelhada', kcal:339, proteina:28.2, carbs:0.0,  gordura:24.6,fibra:0.0 },
    { id:'t035', nome:'Carne bovina, acém, cozido',      kcal:231, proteina:28.0, carbs:0.0,  gordura:13.0,fibra:0.0 },
    { id:'t036', nome:'Fígado bovino, cozido',           kcal:167, proteina:26.5, carbs:4.1,  gordura:4.4, fibra:0.0 },

    // AVES
    { id:'t040', nome:'Frango, peito, sem pele, grelhado', kcal:163, proteina:31.5, carbs:0.0, gordura:3.2, fibra:0.0 },
    { id:'t041', nome:'Frango, coxa, sem pele, assada',  kcal:215, proteina:26.6, carbs:0.0,  gordura:11.7,fibra:0.0 },
    { id:'t042', nome:'Frango, sobrecoxa, sem pele, assada', kcal:221, proteina:25.9, carbs:0.0, gordura:12.9, fibra:0.0 },
    { id:'t043', nome:'Frango, peito, com pele, assado', kcal:197, proteina:30.0, carbs:0.0,  gordura:8.1, fibra:0.0 },
    { id:'t044', nome:'Peru, peito, sem pele, assado',   kcal:159, proteina:29.9, carbs:0.0,  gordura:3.7, fibra:0.0 },

    // SUÍNOS
    { id:'t050', nome:'Lombo suíno, assado',             kcal:211, proteina:30.0, carbs:0.0,  gordura:9.9, fibra:0.0 },
    { id:'t051', nome:'Bacon, frito',                    kcal:541, proteina:37.0, carbs:1.4,  gordura:42.0,fibra:0.0 },
    { id:'t052', nome:'Presunto, cozido',                kcal:109, proteina:14.8, carbs:1.3,  gordura:4.9, fibra:0.0 },
    { id:'t053', nome:'Linguiça, calabresa, assada',     kcal:290, proteina:19.8, carbs:0.0,  gordura:23.3,fibra:0.0 },

    // PEIXES E FRUTOS DO MAR
    { id:'t060', nome:'Atum, enlatado, em água',         kcal:95,  proteina:21.5, carbs:0.0,  gordura:1.1, fibra:0.0 },
    { id:'t061', nome:'Salmão, grelhado',                kcal:237, proteina:29.1, carbs:0.0,  gordura:13.0,fibra:0.0 },
    { id:'t062', nome:'Tilápia, grelhada',               kcal:128, proteina:26.2, carbs:0.0,  gordura:2.7, fibra:0.0 },
    { id:'t063', nome:'Sardinha, enlatada, em óleo',     kcal:270, proteina:24.0, carbs:0.0,  gordura:19.0,fibra:0.0 },
    { id:'t064', nome:'Camarão, cozido',                 kcal:99,  proteina:21.4, carbs:0.0,  gordura:1.1, fibra:0.0 },
    { id:'t065', nome:'Bacalhau, cozido',                kcal:105, proteina:23.7, carbs:0.0,  gordura:0.9, fibra:0.0 },
    { id:'t066', nome:'Pescada, filé, cozida',           kcal:91,  proteina:18.5, carbs:0.0,  gordura:1.9, fibra:0.0 },

    // OVOS E LATICÍNIOS
    { id:'t070', nome:'Ovo, galinha, cozido',            kcal:146, proteina:13.3, carbs:0.6,  gordura:9.5, fibra:0.0 },
    { id:'t071', nome:'Ovo, galinha, frito',             kcal:185, proteina:13.3, carbs:0.4,  gordura:14.1,fibra:0.0 },
    { id:'t072', nome:'Clara de ovo, cozida',            kcal:52,  proteina:10.9, carbs:0.7,  gordura:0.2, fibra:0.0 },
    { id:'t073', nome:'Leite, integral',                 kcal:61,  proteina:3.2,  carbs:4.6,  gordura:3.2, fibra:0.0 },
    { id:'t074', nome:'Leite, desnatado',                kcal:35,  proteina:3.4,  carbs:4.7,  gordura:0.2, fibra:0.0 },
    { id:'t075', nome:'Iogurte, natural, integral',      kcal:66,  proteina:4.1,  carbs:5.1,  gordura:3.2, fibra:0.0 },
    { id:'t076', nome:'Iogurte, grego, integral',        kcal:97,  proteina:9.0,  carbs:3.6,  gordura:5.0, fibra:0.0 },
    { id:'t077', nome:'Queijo minas, frescal',           kcal:264, proteina:17.4, carbs:2.6,  gordura:20.2,fibra:0.0 },
    { id:'t078', nome:'Queijo mussarela',                kcal:300, proteina:22.9, carbs:2.0,  gordura:22.3,fibra:0.0 },
    { id:'t079', nome:'Queijo parmesão',                 kcal:420, proteina:35.2, carbs:0.0,  gordura:30.7,fibra:0.0 },
    { id:'t080', nome:'Requeijão cremoso',               kcal:260, proteina:9.6,  carbs:2.3,  gordura:24.0,fibra:0.0 },
    { id:'t081', nome:'Manteiga, sem sal',               kcal:741, proteina:0.4,  carbs:0.0,  gordura:83.2,fibra:0.0 },
    { id:'t082', nome:'Leite condensado',                kcal:329, proteina:7.4,  carbs:56.0, gordura:8.4, fibra:0.0 },
    { id:'t083', nome:'Creme de leite',                  kcal:319, proteina:2.1,  carbs:3.3,  gordura:32.7,fibra:0.0 },

    // TUBÉRCULOS E RAÍZES
    { id:'t090', nome:'Batata, cozida',                  kcal:52,  proteina:1.2,  carbs:11.9, gordura:0.1, fibra:1.8 },
    { id:'t091', nome:'Batata doce, cozida',             kcal:77,  proteina:0.9,  carbs:18.4, gordura:0.1, fibra:2.2 },
    { id:'t092', nome:'Mandioca, cozida',                kcal:125, proteina:0.6,  carbs:30.1, gordura:0.2, fibra:1.9 },
    { id:'t093', nome:'Inhame, cozido',                  kcal:83,  proteina:1.5,  carbs:19.7, gordura:0.1, fibra:1.4 },
    { id:'t094', nome:'Beterraba, cozida',               kcal:34,  proteina:1.5,  carbs:7.1,  gordura:0.1, fibra:2.8 },
    { id:'t095', nome:'Cenoura, crua',                   kcal:34,  proteina:0.8,  carbs:8.0,  gordura:0.2, fibra:3.2 },
    { id:'t096', nome:'Batata, assada',                  kcal:93,  proteina:2.5,  carbs:21.0, gordura:0.1, fibra:2.0 },

    // VERDURAS
    { id:'t100', nome:'Alface, crua',                    kcal:11,  proteina:1.3,  carbs:1.7,  gordura:0.2, fibra:1.8 },
    { id:'t101', nome:'Espinafre, refogado',             kcal:28,  proteina:3.2,  carbs:2.7,  gordura:0.7, fibra:3.7 },
    { id:'t102', nome:'Brócolis, cozido',                kcal:27,  proteina:3.0,  carbs:3.5,  gordura:0.4, fibra:3.1 },
    { id:'t103', nome:'Couve, refogada',                 kcal:43,  proteina:2.9,  carbs:5.0,  gordura:1.5, fibra:4.0 },
    { id:'t104', nome:'Repolho, cozido',                 kcal:16,  proteina:1.1,  carbs:3.2,  gordura:0.1, fibra:2.2 },
    { id:'t105', nome:'Abobrinha, cozida',               kcal:18,  proteina:1.0,  carbs:3.5,  gordura:0.2, fibra:1.1 },
    { id:'t106', nome:'Tomate, cru',                     kcal:15,  proteina:1.1,  carbs:3.1,  gordura:0.2, fibra:1.2 },
    { id:'t107', nome:'Cebola, crua',                    kcal:37,  proteina:0.9,  carbs:8.6,  gordura:0.1, fibra:2.2 },
    { id:'t108', nome:'Pepino, cru',                     kcal:10,  proteina:0.8,  carbs:1.8,  gordura:0.1, fibra:0.8 },
    { id:'t109', nome:'Milho verde, cozido',             kcal:76,  proteina:2.7,  carbs:16.8, gordura:1.0, fibra:2.5 },
    { id:'t110', nome:'Vagem, cozida',                   kcal:27,  proteina:1.8,  carbs:5.3,  gordura:0.3, fibra:3.2 },
    { id:'t111', nome:'Quiabo, cozido',                  kcal:25,  proteina:1.9,  carbs:4.5,  gordura:0.3, fibra:3.2 },
    { id:'t112', nome:'Abóbora, cozida',                 kcal:26,  proteina:1.0,  carbs:6.0,  gordura:0.1, fibra:1.1 },
    { id:'t113', nome:'Pimentão, cru',                   kcal:20,  proteina:0.9,  carbs:4.2,  gordura:0.3, fibra:1.4 },

    // FRUTAS
    { id:'t120', nome:'Banana, prata',                   kcal:98,  proteina:1.3,  carbs:26.0, gordura:0.1, fibra:2.0 },
    { id:'t121', nome:'Maçã, com casca',                 kcal:56,  proteina:0.3,  carbs:15.2, gordura:0.1, fibra:2.0 },
    { id:'t122', nome:'Laranja, pera',                   kcal:37,  proteina:1.0,  carbs:8.9,  gordura:0.1, fibra:0.8 },
    { id:'t123', nome:'Mamão, papaia',                   kcal:40,  proteina:0.6,  carbs:10.4, gordura:0.1, fibra:1.8 },
    { id:'t124', nome:'Manga, comum',                    kcal:64,  proteina:0.4,  carbs:17.0, gordura:0.2, fibra:1.6 },
    { id:'t125', nome:'Morango',                         kcal:30,  proteina:0.8,  carbs:7.1,  gordura:0.3, fibra:2.0 },
    { id:'t126', nome:'Abacaxi',                         kcal:48,  proteina:0.9,  carbs:12.3, gordura:0.1, fibra:1.0 },
    { id:'t127', nome:'Melancia',                        kcal:33,  proteina:0.6,  carbs:8.1,  gordura:0.1, fibra:0.3 },
    { id:'t128', nome:'Uva, italia',                     kcal:69,  proteina:0.6,  carbs:17.7, gordura:0.1, fibra:0.9 },
    { id:'t129', nome:'Abacate',                         kcal:96,  proteina:1.2,  carbs:6.0,  gordura:8.4, fibra:6.3 },
    { id:'t130', nome:'Goiaba',                          kcal:54,  proteina:2.6,  carbs:10.3, gordura:1.0, fibra:6.3 },
    { id:'t131', nome:'Maracujá, suco',                  kcal:64,  proteina:2.0,  carbs:15.2, gordura:0.1, fibra:0.3 },
    { id:'t132', nome:'Caju',                            kcal:43,  proteina:1.0,  carbs:9.8,  gordura:0.5, fibra:1.5 },
    { id:'t133', nome:'Açaí, polpa',                     kcal:58,  proteina:1.1,  carbs:6.5,  gordura:3.9, fibra:2.6 },
    { id:'t134', nome:'Limão, suco',                     kcal:28,  proteina:1.1,  carbs:7.0,  gordura:0.3, fibra:0.3 },
    { id:'t135', nome:'Pêssego',                         kcal:43,  proteina:0.9,  carbs:10.2, gordura:0.2, fibra:1.7 },

    // OLEAGINOSAS
    { id:'t140', nome:'Amendoim, torrado',               kcal:567, proteina:26.0, carbs:21.5, gordura:43.9,fibra:8.0 },
    { id:'t141', nome:'Pasta de amendoim',               kcal:567, proteina:24.5, carbs:19.0, gordura:47.0,fibra:7.0 },
    { id:'t142', nome:'Amêndoa, crua',                   kcal:581, proteina:18.6, carbs:19.7, gordura:50.6,fibra:12.5 },
    { id:'t143', nome:'Castanha de caju, torrada',       kcal:574, proteina:15.3, carbs:32.7, gordura:46.4,fibra:3.0 },
    { id:'t144', nome:'Castanha do pará',                kcal:656, proteina:14.3, carbs:15.1, gordura:63.5,fibra:7.9 },
    { id:'t145', nome:'Nozes',                           kcal:620, proteina:14.0, carbs:18.3, gordura:59.4,fibra:4.8 },
    { id:'t146', nome:'Semente de chia',                 kcal:490, proteina:16.5, carbs:42.1, gordura:30.7,fibra:34.4 },
    { id:'t147', nome:'Semente de linhaça',              kcal:495, proteina:18.3, carbs:28.9, gordura:42.2,fibra:27.3 },

    // ÓLEOS E GORDURAS
    { id:'t150', nome:'Azeite de oliva',                 kcal:884, proteina:0.0,  carbs:0.0,  gordura:100.0,fibra:0.0 },
    { id:'t151', nome:'Óleo de soja',                    kcal:884, proteina:0.0,  carbs:0.0,  gordura:100.0,fibra:0.0 },
    { id:'t152', nome:'Óleo de coco',                    kcal:884, proteina:0.0,  carbs:0.0,  gordura:100.0,fibra:0.0 },

    // AÇÚCARES
    { id:'t160', nome:'Açúcar, refinado',                kcal:400, proteina:0.0,  carbs:99.6, gordura:0.0, fibra:0.0 },
    { id:'t161', nome:'Mel',                             kcal:309, proteina:0.3,  carbs:84.0, gordura:0.0, fibra:0.3 },
    { id:'t162', nome:'Açúcar mascavo',                  kcal:375, proteina:0.0,  carbs:97.4, gordura:0.0, fibra:0.0 },
    { id:'t163', nome:'Doce de leite',                   kcal:323, proteina:6.9,  carbs:55.1, gordura:8.5, fibra:0.0 },

    // REFRIGERANTES
    { id:'t200', nome:'Sprite',                              kcal:41,  proteina:0.0,  carbs:10.6, gordura:0.0, fibra:0.0 },

    // VARIAÇÕES DE FRANGO
    { id:'t045', nome:'Frango, peito, sem pele, cozido',     kcal:159, proteina:31.5, carbs:0.0, gordura:2.5, fibra:0.0 },
    { id:'t046', nome:'Frango, peito, sem pele, frito',      kcal:219, proteina:31.1, carbs:4.2, gordura:8.8, fibra:0.0 },
    { id:'t047', nome:'Frango, peito, sem pele, assado',     kcal:165, proteina:31.0, carbs:0.0, gordura:3.6, fibra:0.0 },
    { id:'t048', nome:'Frango, peito, com pele, frito',      kcal:289, proteina:29.8, carbs:3.5, gordura:17.4,fibra:0.0 },
    { id:'t049', nome:'Frango, coxa, com pele, frita',       kcal:295, proteina:24.0, carbs:3.8, gordura:20.5,fibra:0.0 },

    // VARIAÇÕES DE ARROZ
    { id:'t003b', nome:'Arroz, branco, cru',                 kcal:358, proteina:7.4,  carbs:79.7, gordura:0.5, fibra:2.0 },
    { id:'t003c', nome:'Arroz, integral, cru',               kcal:360, proteina:7.4,  carbs:78.3, gordura:1.9, fibra:4.5 },
    { id:'t003d', nome:'Arroz, parboilizado, cozido',        kcal:130, proteina:2.7,  carbs:28.9, gordura:0.3, fibra:1.4 },

    // VARIAÇÕES DE OVO
    { id:'t073b', nome:'Ovo, galinha, mexido',               kcal:149, proteina:9.9,  carbs:1.1,  gordura:11.5,fibra:0.0 },
    { id:'t073c', nome:'Ovo, galinha, estrelado',            kcal:185, proteina:13.3, carbs:0.4,  gordura:14.1,fibra:0.0 },
    { id:'t073d', nome:'Ovo, galinha, cru',                  kcal:143, proteina:13.0, carbs:0.7,  gordura:9.5, fibra:0.0 },

    // VARIAÇÕES DE BATATA
    { id:'t090b', nome:'Batata, frita, óleo',                kcal:316, proteina:3.4,  carbs:40.3, gordura:16.2,fibra:3.3 },
    { id:'t090c', nome:'Batata, purê',                       kcal:83,  proteina:2.0,  carbs:16.8, gordura:1.2, fibra:1.5 },
    { id:'t090d', nome:'Batata, assada, com casca',          kcal:93,  proteina:2.5,  carbs:21.0, gordura:0.1, fibra:2.0 },

    // VARIAÇÕES DE CARNE
    { id:'t037', nome:'Carne bovina, cozida',                kcal:219, proteina:32.0, carbs:0.0,  gordura:9.9, fibra:0.0 },
    { id:'t038', nome:'Carne bovina, assada',                kcal:248, proteina:31.0, carbs:0.0,  gordura:13.0,fibra:0.0 },
    { id:'t039', nome:'Carne bovina, frita',                 kcal:272, proteina:28.5, carbs:0.0,  gordura:17.2,fibra:0.0 },

    // VARIAÇÕES DE FEIJÃO
    { id:'t028', nome:'Feijão, carioca, cru',                kcal:324, proteina:21.4, carbs:58.6, gordura:1.4, fibra:26.3 },
    { id:'t029', nome:'Feijão, preto, cru',                  kcal:335, proteina:22.3, carbs:58.0, gordura:1.6, fibra:25.4 },

    // VARIAÇÕES DE LEITE
    { id:'t073e', nome:'Leite achocolatado',                    kcal:78,  proteina:3.2,  carbs:12.0, gordura:2.0, fibra:0.3 },

    // VARIAÇÕES DE BATATA DOCE
    { id:'t091b', nome:'Batata doce, cozida, sem casca',     kcal:74,  proteina:0.9,  carbs:17.8, gordura:0.1, fibra:2.0 },
    { id:'t091c', nome:'Batata doce, assada, com casca',     kcal:90,  proteina:1.2,  carbs:21.3, gordura:0.1, fibra:2.5 },

    // MACARRÃO VARIAÇÕES
    { id:'t003e', nome:'Macarrão, espaguete, cozido',        kcal:131, proteina:4.9,  carbs:26.0, gordura:0.8, fibra:1.8 },
    { id:'t003f', nome:'Macarrão, parafuso, cozido',         kcal:133, proteina:5.1,  carbs:26.3, gordura:0.8, fibra:1.9 },

    // OVOS ADICIONAIS
    { id:'t074b', nome:'Omelete, 1 ovo, sem recheio',        kcal:154, proteina:10.6, carbs:0.5,  gordura:12.0, fibra:0.0 },
    { id:'t074c', nome:'Ovo, galinha, pochê',                kcal:143, proteina:13.0, carbs:0.7,  gordura:9.5,  fibra:0.0 },

    // OUTRAS CARNES E PEIXES
    { id:'t055', nome:'Frango, inteiro, assado, sem pele',   kcal:197, proteina:29.8, carbs:0.0,  gordura:8.4, fibra:0.0 },
    { id:'t056', nome:'Frango, nuggets, frito',              kcal:296, proteina:15.4, carbs:18.0, gordura:18.5,fibra:0.8 },
    { id:'t058', nome:'Frango, peito, empanado, frito',      kcal:246, proteina:25.4, carbs:11.5, gordura:10.8, fibra:0.5 },
    { id:'t059', nome:'Frango, sobrecoxa, com pele, frita',  kcal:312, proteina:23.8, carbs:4.5,  gordura:22.1, fibra:0.0 },
    { id:'t057', nome:'Carne suína, lombo, grelhado',        kcal:195, proteina:28.8, carbs:0.0,  gordura:8.9, fibra:0.0 },
    { id:'t067', nome:'Atum, enlatado, em óleo',             kcal:198, proteina:28.9, carbs:0.0,  gordura:9.0, fibra:0.0 },
    { id:'t068', nome:'Salmão, cru',                         kcal:208, proteina:20.4, carbs:0.0,  gordura:13.4,fibra:0.0 },
    { id:'t069', nome:'Tilápia, crua',                       kcal:96,  proteina:20.1, carbs:0.0,  gordura:1.7, fibra:0.0 },
];

// Aliases para busca (variações e sinônimos)
const ALIASES = {
    'arroz': ['t001','t002'],
    'arroz branco': ['t001'],
    'arroz integral': ['t002'],
    'macarrao': ['t003','t004'],
    'macarrão': ['t003','t004'],
    'espaguete': ['t003'],
    'aveia': ['t005'],
    'pao': ['t006','t007'],
    'pão': ['t006','t007'],
    'pao frances': ['t006'],
    'pão francês': ['t006'],
    'pão integral': ['t007'],
    'tapioca': ['t009'],
    'feijao': ['t020','t021'],
    'feijão': ['t020','t021'],
    'feijao preto': ['t020'],
    'feijão preto': ['t020'],
    'feijao carioca': ['t021'],
    'feijão carioca': ['t021'],
    'lentilha': ['t023'],
    'grao de bico': ['t024'],
    'grão de bico': ['t024'],
    'frango': ['t040','t041'],
    'peito de frango': ['t040'],
    'coxa de frango': ['t041'],
    'ovo': ['t070'],
    'ovos': ['t070'],
    'ovo cozido': ['t070'],
    'clara': ['t072'],
    'clara de ovo': ['t072'],
    'leite': ['t073', 't074', 't073e'],
    'leite integral': ['t073'],
    'leite desnatado': ['t074'],
    'leite achocolatado': ['t073e'],
    'iogurte': ['t075','t076'],
    'iogurte grego': ['t076'],
    'queijo minas': ['t077'],
    'atum': ['t060'],
    'atum em lata': ['t060'],
    'salmao': ['t061'],
    'salmão': ['t061'],
    'tilapia': ['t062'],
    'tilápia': ['t062'],
    'camarao': ['t064'],
    'camarão': ['t064'],
    'batata': ['t090'],
    'batata cozida': ['t090'],
    'batata doce': ['t091'],
    'mandioca': ['t092'],
    'aipim': ['t092'],
    'cenoura': ['t095'],
    'tomate': ['t106'],
    'brocolis': ['t102'],
    'brócolis': ['t102'],
    'espinafre': ['t101'],
    'banana': ['t120'],
    'maca': ['t121'],
    'maçã': ['t121'],
    'laranja': ['t122'],
    'mamao': ['t123'],
    'mamão': ['t123'],
    'manga': ['t124'],
    'morango': ['t125'],
    'abacate': ['t129'],
    'amendoim': ['t140'],
    'pasta de amendoim': ['t141'],
    'amendoa': ['t142'],
    'amêndoa': ['t142'],
    'castanha de caju': ['t143'],
    'castanha do para': ['t144'],
    'castanha do pará': ['t144'],
    'chia': ['t146'],
    'linhaca': ['t147'],
    'linhaça': ['t147'],
    'azeite': ['t150'],
    'oleo de soja': ['t151'],
    'óleo de soja': ['t151'],
    'acucar': ['t160'],
    'açúcar': ['t160'],
    'mel': ['t161'],
    'sprite': ['t200'],
    'frango cozido':            ['t045'],
    'frango frito':             ['t046'],
    'frango assado':            ['t047'],
    'peito de frango cozido':   ['t045'],
    'peito de frango grelhado': ['t040'],
    'peito de frango frito':    ['t046'],
    'peito de frango assado':   ['t047'],
    'coxa de frango frita':     ['t049'],
    'ovo mexido':               ['t073b'],
    'ovo frito':                ['t073c'],
    'ovo estrelado':            ['t073c'],
    'ovo cru':                  ['t073d'],
    'batata frita':             ['t090b'],
    'batata pure':              ['t090c'],
    'batata purê':              ['t090c'],
    'batata assada':            ['t090d'],
    'batata doce cozida':       ['t091b'],
    'batata doce assada':       ['t091c'],
    'arroz cru':                ['t003b'],
    'arroz parboilizado':       ['t003d'],
    'feijao cru':               ['t028'],
    'feijão cru':               ['t028'],
    'carne cozida':             ['t037'],
    'carne assada':             ['t038'],
    'carne frita':              ['t039'],
    'nuggets':                  ['t056'],
    'frango nuggets':           ['t056'],
    'atum em oleo':             ['t067'],
    'atum em óleo':             ['t067'],
    'salmao cru':               ['t068'],
    'salmão cru':               ['t068'],
    'omelete':                  ['t074b'],
    'ovo poche':                ['t074c'],
    'ovo pochê':                ['t074c'],
    'frango empanado':          ['t058'],
    'sobrecoxa frita':          ['t059'],
};

const GRUPOS = {
    'frango':           ['t040','t041','t042','t043','t045','t046','t047','t048','t049','t055','t056','t058','t059'],
    'peito de frango':  ['t040','t045','t046','t047','t048','t058'],
    'coxa de frango':   ['t041','t049','t059'],
    'ovo':              ['t070','t073b','t073c','t073d','t072','t074b','t074c'],
    'ovos':             ['t070','t073b','t073c','t073d','t072','t074b','t074c'],
    'arroz':            ['t001','t002','t003b','t003d'],
    'batata':           ['t090','t090b','t090c','t090d'],
    'batata doce':      ['t091','t091b','t091c'],
    'carne':            ['t030','t031','t032','t033','t037','t038','t039'],
    'feijao':           ['t020','t021','t022'],
    'feijão':           ['t020','t021','t022'],
    'macarrao':         ['t003','t004','t003e','t003f'],
    'macarrão':         ['t003','t004','t003e','t003f'],
    'atum':             ['t060','t067'],
    'salmao':           ['t061','t068'],
    'salmão':           ['t061','t068'],
    'tilapia':          ['t062','t069'],
    'tilápia':          ['t062','t069'],
    'leite':            ['t073','t074','t073e'],
    'iogurte':          ['t075','t076'],
    'queijo':           ['t077','t078','t079','t080'],
    'fruta':            ['t120','t121','t122','t123','t124','t125'],
};

function normalize(s) {
    return s.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function searchTaco(query) {
    const q = normalize(query);

    // 0. Busca por GRUPO — retorna todas as variações do alimento
    const grupoKey = Object.keys(GRUPOS).find(k => normalize(k) === q);
    if (grupoKey) {
        return GRUPOS[grupoKey]
            .map(id => TACO.find(t => t.id === id))
            .filter(Boolean)
            .map(tacoToResult);
    }

    // 1. Busca por ALIAS exato — variação específica
    const aliasKey = Object.keys(ALIASES).find(k => normalize(k) === q);
    if (aliasKey) {
        return ALIASES[aliasKey]
            .map(id => TACO.find(t => t.id === id))
            .filter(Boolean)
            .map(tacoToResult);
    }

    // 2. Full-text simples — fallback para termos não mapeados
    const qWords = q.split(' ').filter(w => w.length > 2);
    if (!qWords.length) return [];

    return TACO
        .map(item => {
            const nomeNorm = normalize(item.nome);
            const matchCount = qWords.filter(w => nomeNorm.includes(w)).length;
            return { item, score: matchCount / qWords.length };
        })
        .filter(r => r.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(r => tacoToResult(r.item));
}

function tacoToResult(item) {
    return {
        id:      item.id,
        nome:    item.nome,
        fonte:   'taco',
        por100g: {
            kcal:     item.kcal,
            proteina: item.proteina,
            carbs:    item.carbs,
            gordura:  item.gordura,
            fibra:    item.fibra,
        },
    };
}

module.exports = { searchTaco, TACO, ALIASES, GRUPOS };
