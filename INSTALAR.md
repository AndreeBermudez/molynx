# Agent Review — instalación para pruebas

Extensión de VS Code para revisar, bloque por bloque, los cambios que hace
Claude Code en tus archivos: cada cambio se puede aceptar o rechazar desde el
editor, como en GitHub Copilot.

> Versión de prueba local (no está publicada en el Marketplace).
> Autor: AndreeBermudez.

## Requisitos

- VS Code 1.85 o superior (también funciona en forks como Antigravity o Cursor).
- Claude Code o Codex instalado, según el agente que quieras conectar.
- Node.js instalado y disponible en el PATH (`node --version` debe responder).

## Instalación (3 pasos)

### 1. Instalar la extensión

En VS Code: **Extensions** (Ctrl+Shift+X) → menú **`…`** → **Install from VSIX…**
→ elige `agent-review-0.7.0.vsix`.

> ¿Usas perfiles de VS Code? Instálala estando en el perfil con el que abres
> tu proyecto, o por terminal:
> `code --install-extension agent-review-0.7.0.vsix --profile "Nombre del perfil"`

Luego recarga: Ctrl+Shift+P → **Developer: Reload Window**.

### 2. Conectarla con Claude Code

Al recargar aparece un aviso **"Agent Review: conéctalo a Claude Code…"** →
pulsa **Conectar** y confirma.

Si no lo ves: Ctrl+Shift+P → **Agent Review: Conectar con Claude Code**.

Esto hace dos cosas (con tu confirmación):
- copia el script del hook a `~/.agent-review/snapshot.js`;
- lo registra en `~/.claude/settings.json`, guardando antes una copia en
  `~/.claude/settings.json.agent-review.bak`.

### 3. Recargar Claude Code

En el chat de Claude Code escribe **`/hooks`** y ciérralo (con abrirlo una vez
basta), o reinicia la sesión de Claude Code.

## Conectar Codex (opcional)

En VS Code ejecuta **Agent Review: Conectar con Codex** desde `Ctrl+Shift+P` y confirma. La extensión copiará el hook a `~/.agent-review/codex.js`, lo registrará para `apply_patch` en `~/.codex/hooks.json` y guardará una copia en `~/.codex/hooks.json.agent-review.bak`.

Reinicia Codex. En Codex CLI abre `/hooks` para revisar y confiar el hook cuando lo solicite. Con Agent Review activo y el proyecto abierto en VS Code, los cambios de Codex hechos con `apply_patch` aparecerán para revisión. Los cambios hechos mediante comandos de terminal no se capturan automáticamente.

También puedes desconectarlo con **Agent Review: Desconectar de Codex**.

## Probarlo

1. Abre tu proyecto como carpeta en VS Code (solo se revisan archivos dentro
   de las carpetas abiertas).
2. Pídele a Claude Code un cambio pequeño en algún archivo.
3. Se abre la comparación: en **rojo** lo que había, en **verde** lo nuevo.
   Debajo de cada bloque hay un recuadro con:

   | Botón | Acción |
   | --- | --- |
   | ✓ (verde) | Aceptar este bloque |
   | ✗ (rojo) | Rechazar este bloque (vuelve al texto anterior) |
   | ✓✓ | Aceptar todo el archivo |
   | ⟲ | Rechazar todo el archivo |
   | ↑ ↓ | Ir al bloque anterior / siguiente |

4. Cuando no quedan bloques, el archivo se guarda y la pestaña se cierra sola.
   Si el agente cambió varios archivos, se abren de uno en uno.

Atajos: `Ctrl+Alt+Y` acepta, `Ctrl+Alt+N` rechaza, `Ctrl+Alt+]` / `Ctrl+Alt+[`
saltan entre bloques.

## El escudo de la barra inferior

| Se ve | Significa | Clic |
| --- | --- | --- |
| Escudo azul | Revisión activa | Desactivar |
| Escudo azul con número | Hay archivos por revisar | Ver la lista (ahí también se desactiva) |
| ⊘ gris | Revisión desactivada | Activar |

**Importante:** con la revisión **activa**, Claude Code ya no te pide permiso
para editar archivos de tu workspace; los revisas después con los botones.
Con la revisión **desactivada**, Claude Code vuelve a comportarse como siempre.

## Problemas comunes

| Síntoma | Solución |
| --- | --- |
| Claude Code sigue pidiendo su propia aprobación | Falta el paso 3 (`/hooks` o reiniciar la sesión), o la revisión está desactivada (escudo gris). |
| No aparece el escudo en la barra inferior | La extensión está en otro perfil de VS Code: reinstálala en el perfil correcto (paso 1). |
| No se abre la revisión | El archivo está fuera de las carpetas abiertas en VS Code, o Node.js no está en el PATH. |
| "No pude leer settings.json" | Tu `~/.claude/settings.json` tiene un error de formato; corrígelo y vuelve a conectar. |

## Desinstalar

1. Ctrl+Shift+P → **Agent Review: Desconectar de Claude Code** y/o **Agent Review: Desconectar de Codex**.
2. Desinstala la extensión desde **Extensions**.
3. Opcional: borra la carpeta `~/.agent-review`.

## Dar feedback

Anota qué hiciste, qué esperabas y qué pasó; una captura de pantalla ayuda mucho.
