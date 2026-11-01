# Simón — descargas

Instaladores de la app Simón (https://simon.maat.work) para macOS, Windows y
Android. Este repositorio sólo contiene binarios publicados por el proceso de
release del proyecto; el código no está acá.

Bajá siempre la última versión desde https://simon.maat.work/descargar.

| Plataforma | Archivo |
|---|---|
| macOS (Apple Silicon e Intel) | `Simon.dmg` |
| Windows 10/11 (64 bits) | `Simon-setup.exe` |
| Android 9+ | `Simon.apk` |

`latest.json` es el manifiesto que usa la app de escritorio para actualizarse
sola.

## QA manual de Windows (binarios instalados)

Este repositorio también mantiene **sólo el arnés público de QA**, no el código
de la aplicación. `.github/workflows/windows-native-qa.yml` no compila, publica,
crea tags ni modifica releases. Es exclusivamente `workflow_dispatch`, usa el
runner estándar gratuito `windows-2025` de este repositorio público y nunca
usa el equipo/perfil de una persona, WSL, un fork privado ni recursos pagos.

### CI offline del PR (sin credenciales)

`.github/workflows/offline-checks.yml` ejecuta **sólo `pull_request` hacia `main`**
en el runner estándar gratuito `ubuntu-24.04`, con `contents:read`. Usa los
mismos SHA completos de checkout/setup-node, `persist-credentials:false` y
Node 22 con WebSocket global. `npm ci --ignore-scripts` exige el lockfile;
después analiza todos los CJS y ejecuta únicamente los unit cases de contrato,
raw-CDP e issuer.

Este carril no declara environment ni secrets, no conserva credenciales/cache,
no descarga instaladores, no inicia la app/Playwright, no hace login ni llama
al gateway/modelo. No usa `pull_request_target`, `workflow_run`, código privado
ni ejecución privilegiada. Puede producir evidencia CI del PR antes del merge,
sin ejecutar ni aprobar el workflow manual de Windows.
**Offline CI PASS ≠ Windows QA PASS, aprobación de `qa-windows`, consentimiento,
admisión de GPU o autorización de release.** El arnés Windows con credenciales
sigue exclusivamente `workflow_dispatch` sobre `main`, en su environment separado.


### Barreras antes del primer dispatch

1. Revisar y mergear el workflow Windows y sus scripts a `main`.
   **Bootstrap manual Windows bloqueado:** GitHub no permite ejecutar un
   workflow_dispatch nuevo antes de que exista en la rama por defecto. La CI
   offline del PR sí es independiente; su resultado no prueba el workflow Windows.
2. Configurar el environment **`qa-windows`** con *Selected branches and tags*:
   **únicamente branch `main`, ningún tag**. No usar “Protected branches only”:
   sin ramas protegidas, esa opción permite todas. Agregar revisión de owner y
   proteger `main`/los archivos de workflow antes de cargar credenciales. El `if`
   del YAML no puede proteger secretos si alguien edita ese mismo `if` en otra
   rama: la restricción del environment es obligatoria, no una recomendación.
3. El owner de cuenta prepara y verifica el fixture dedicado, no una cuenta
   personal: id inmutable `simon-qa-native-v1`, `role=self`, clase interna `test`,
   plan free, sin datos reales. La operación canónica de cuenta verifica las
   exclusiones de métricas/tracking/cobros; el cliente no inventa ese marcador
   ni obtiene permisos enviando un header. Cargar **sólo** los environment
   secrets `SIMON_QA_EMAIL` y `SIMON_QA_PASSWORD`, después de esa verificación.
   Nunca usar `user-login.env`, secretos de inferencia ni un PAT en Actions.
   La única copia local de credenciales es
   `~/.hermes/project-env/HerMaatOS/work/simon-ai/qa-windows.env`, modo `0600`;
   nunca imprimirla ni adjuntarla. El issuer de admisión no la necesita.
4. El seed `self` deja **perfil de identidad vacío** (`profileCompletedAt=null`)
   y permiso funcional de IA ausente. Son requisitos humanos **separados**:
   - Primero el owner debe revisar y autorizar el flujo web normal
     `/completar-perfil`: pide identidad, confirmación 18+ y check de DNI. El
     selector nativo `/perfil` no completa esa identidad y la app no incluye
     `/completar-perfil`. No inventar datos, declaraciones ni defaults; no usar
     identidad de Gio ni datos reales. Si no existe un procedimiento QA legítimo
     autorizado compatible con esas restricciones, **full sigue bloqueado**.
   - Después se requiere aceptación funcional IA normal y explícita, aparte.
     Mantener apagados analytics, marketing y training opcionales.
   El arnés nunca completa perfil ni acepta/simula/puentea consentimientos.
   `baseline-login` y `upgrade-login` son parciales y no generan.
   `full-generation` falla primero `profile_incomplete` (o
   `profile_state_unknown` si no se observa el campo) y luego `consent_required`
   cuando corresponda, siempre antes de pedir admisión. No es “un click” que
   autorice perfil, IA, recursos y release juntos ni se cambia política por un verde.
5. Para candidato: el owner debe tener primero el fine-grained ContentsRW
   autorizado **sólo** para este repositorio; sin eso no crear tag/release.
   Preparar posteriormente el draft `v0.1.12` y revisar los ids y SHA256 de sus
   assets. Este workflow sólo usa el `GITHUB_TOKEN` efímero del mismo repo con
   `contents:read` y `statuses:read`; no necesita token de publicación.
6. Hacer la revisión y los checks offline de abajo una sola vez bajo el owner de
   integración. Ningún dispatch ni instalación se ejecutó al agregar este arnés.
   La barrera de telemetría previa a JS también debe observarse en Windows real;
   su implementación/offline tests no equivalen a cero huella en producción.

### Modos y ejecución manual

Desde un entorno autorizado, **no son comandos que se ejecuten automáticamente**:

```sh
# Sin candidato, sin solicitud de chat, sin admisión de generación.
gh workflow run windows-native-qa.yml --repo Gigisanta/simon-releases \
  --ref main -f mode=baseline-login

# Consultar ids/digests del draft, sin imprimir notas ni cuerpos de aplicación.
gh api repos/Gigisanta/simon-releases/releases \
  --jq '.[] | select(.tag_name == "v0.1.12" and .draft) | {id, assets: [.assets[] | {id,name,digest}]}'

# Sustituir con identidades revisadas, no nombres móviles ni URLs arbitrarias.
gh workflow run windows-native-qa.yml --repo Gigisanta/simon-releases \
  --ref main -f mode=upgrade-login \
  -f candidate_release_id=REVIEWED_RELEASE_ID \
  -f candidate_asset_id=REVIEWED_INSTALLER_ASSET_ID \
  -f candidate_sha256=REVIEWED_64_LOWERCASE_HEX_SHA256
```

`baseline-login` instala el NSIS público 0.1.9 pinneado por release id, asset id y
SHA256. `upgrade-login`/`full-generation` instalan primero ese mismo baseline,
lo arrancan e ingresan por su UI, lo cierran y ejecutan el **NSIS original** del
candidato sobre **el mismo directorio**, sin desinstalar ni limpiar sus datos.
Se verifican el registro NSIS y el recurso de versión de `simon.exe` después
de cada instalación; el proceso arrancado se vincula a ese path y a una ventana
Win32 real. Se conserva el mismo directorio WebView2 y se registra si hubo
restauración de sesión; después se hace también login real con contraseña.

Las descargas usan ids del mismo repo, checksums de GitHub y firma criptográfica
Tauri/minisign del instalador contra la clave pública ya distribuida en 0.1.9,
incluido su comentario firmado de versión. `latest.json` debe corresponder a la
misma firma/versión/URL. El draft se relee antes de ejecutar y antes de generar.
Un candidato publicado, una selección ambigua, una sustitución de asset, un
checksum/firma distinto o una rama/SHA que ya no sea el `main` actual bloquean.

**Firma de updater ≠ Authenticode:** estos binarios Windows salen sin certificado
de firma de código de pago. Se exige y registra `NotSigned` para instalador y
ejecutable, además de la firma Tauri válida. Un cambio de identidad Authenticode
requiere revisión; no se lo acepta silenciosamente. Tampoco se afirma que se
haya probado una oferta/instalación del updater: este recorrido es una
**actualización manual NSIS**, y `updaterInstall=not-exercised`.

### Telemetría anónima: barrera anterior a scripts del producto

La clase `test` no identifica el POST legacy `auth:false`. Por eso no basta
con excluir la cuenta en DB, ni con instalar `page.route` después de arrancar.
Microsoft documenta
[`WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.4258.31)
para esperar `Runtime.runIfWaitingForDebugger`. El
[`connectOverCDP` de Playwright 1.58.2](https://github.com/microsoft/playwright/blob/v1.58.2/packages/playwright-core/src/server/chromium/crPage.ts)
ya envía ese comando durante su inicialización; **no es el primer cliente**.

El ejecutable se inicia con esa variable y CDP loopback, sin credenciales en su
environment. Antes de conectar Playwright se inicia `windows-cdp-guard.cjs`,
un guardian raw-CDP separado, sin secretos y ligado al PID/path/boot de esa app:

1. Descubre exactamente un target page local; rechaza otro origen, más targets
   o un WebSocket que no sea su `127.0.0.1:port/devtools/page/id`.
2. Registra/bufferea eventos antes de habilitar `Debugger`. **No usa
   `Runtime.enable`, Playwright ni un attach auto-resumidor** en esta fase.
   La respuesta de `Page.getFrameTree` en el mismo socket es la barrera de
   catch-up; exige **cero scripts previos**, incluidos scripts de preload y
   anónimos. No intenta adivinar cuáles podrían haber sido inocuos.
3. Una evaluación propia identificada sólo contiene `debugger`. Exige su
   `Debugger.paused` con un único frame y script id concordante. Esa es una
   pausa V8 explícitamente observada, **no** una supuesta confirmación de la
   variable WebView ni `Target.waitingForDebugger` de otro tipo de suspensión.
4. Dentro de ese frame pausado instala y lee el ACK del hook
   `windows-telemetry-guard.cjs`. Rechaza un bridge preexistente, ausencia de
   fetch, ACK incorrecto o cualquier script ajeno previo al hook.
5. Arma tanto `Page.addScriptToEvaluateOnNewDocument` como el breakpoint
   `beforeScriptExecution`; **sólo entonces** envía
   `Runtime.runIfWaitingForDebugger` y `Debugger.resume`. El guardian permanece
   conectado entre steps, pausa cada script y confirma el hook antes de
   reanudarlo, también en la recarga nativa de generación. Procesa pausas
   bufferizadas antes de esperar la respuesta de la evaluación de bootstrap.

El hook rechaza **sólo POST** al origen exacto
`https://simon.maat.work` y path `/api/telemetry/section-view`, con o sin query:
en `window.fetch` y antes del
[`invoke('plugin:http|fetch', {clientConfig: {url, method}})` oficial](https://github.com/tauri-apps/plugins-workspace/blob/74a44c1d5694324b7fb9ba5ee9271a3096da9387/plugins/http/guest-js/index.ts).
El recurso HTTP Rust de ese endpoint no llega a crearse. Intercepta la creación
del bridge Tauri, incluso asignación y `Object.defineProperty` del invoke
inmutable, en vez de fingir que una ruta WebView alcanza el transporte Rust.
Los demás endpoints/verbos/comandos reciben los mismos argumentos originales:
no fabrica respuestas de auth/chat/consentimiento ni deshabilita telemetría global.
El login exige además que fetch y el invoke ya creado sigan efectivamente
guardados antes de escribir credenciales.

Falta de ACK, catch-up no vacío, target ambiguo, guardian caído o heartbeat
viejo bloquean la UI. Un fallo del guardian termina **su PID original** antes
de desconectar el debugger; si no puede terminarlo, conserva la sesión abierta,
sin reanudación deliberada. No puede borrar el estado de un candidato posterior.

La evidencia publica únicamente el tipo de pausa/orden observado, cero scripts
previos, ACK antes de resume, guardian persistente y contadores de bloqueos
fetch/invoke. **`zeroFootprint=not-claimed` permanece explícito**: navegación,
servicios nativos fuera del bridge u otras fuentes no se convierten en “cero
tráfico global”. Hasta el primer run Windows real y la correlación del owner,
la exclusión total sigue **sin verificar**; un contador cero no prueba que el
tracker intentó enviar ni que la instrumentación haya sido ejercitada.

### Generación: UI real y admisión externa

`windows-ui.cjs` inicia el **ejecutable instalado**, habilita el CDP de su
WebView2 sólo en loopback y usa `playwright-core` contra esa ventana. No inicia
Chromium, no abre la web en lugar de la app y no sustituye login/chat por API.
Los únicos fetch directos a la aplicación son `GET /api/health`. Las lecturas
de sesión/estado de perfil, consentimiento e historial son observaciones de
solicitudes de la propia UI nativa. Se exige el id fixture y rol exactos; el email
se compara en memoria sin persistirlo.

Para `full-generation`, usar los mismos ids/checksum y cambiar sólo el modo.
El paso de nombre histórico `Check normal AI consent without accepting it`
comprueba ahora **perfil + IA + UI restaurada**, antes del paso exacto
**`Esperar admisión de generación`** del job `windows-native`. Lee
`profileCompletedAt` de la respuesta normal `get-session`, publica sólo su
estado completo/incompleto/desconocido y nunca lo escribe ni publica su fecha.
Un perfil incompleto bloquea incluso si IA fue otorgada por separado.

La respuesta IA puede llegar antes del commit de React: el arnés espera de forma
acotada el composer **visible y habilitado**, no decide `consent_required` con
un `count/isVisible/isEnabled` instantáneo. Falta de grant y falta de readiness
siguen siendo resultados distintos; no se acepta un consentimiento para avanzar.

El preflight recarga la ventana instalada y observa, sin llamar desde el arnés,
`GET /api/chat/resume?allowOrphan=1`. Espera tanto cuerpo HTTP como restauración
de las burbujas por rol/texto en la UI; para historial vacío exige el estado vacío
ya comprobado, no sólo cero burbujas mientras carga. Error de resume o turno
pendiente/orphan bloquea: no se pulsa Reintentar ni se reutiliza un envío incierto.
Sólo se guardan conteos y ACK de restauración en un handoff privado ligado al
PID/boot actual; nunca cuerpos, títulos ni ids de historial.

Generación no vuelve a recargar después del preflight. Tras esperar admisión y
el precheck final, toma el conteo de asistentes **adyacente al único click
admitido**, dentro del deadline de 30 s. Si cambió desde la restauración,
falla antes del click en vez de consumir el turno y dar luego un falso timeout.
Un click parcialmente entregado tampoco se reintenta automáticamente.

El runner no puede medir los recursos de la máquina que aloja la inferencia.
El owner local debe usar el contrato canónico `docs/qa-admission.md` y la
operación persistente `.github/scripts/admitted-action.cjs` del checkout fuente
revisado, **dentro del resource guard apropiado**, y observar el paso exacto
`in_progress` de esta corrida. Su precheck vivo conserva por separado banco,
quiet, tráfico, `gpu_hold`, coordinación/propiedad y la ventana fuera de
**01:00–08:00 ART**. No se quita un hold ajeno ni se transmite autenticación
de inferencia a Actions.

Después de ese precheck, el issuer local crea **una sola vez** un commit status
sobre el `github.sha` de la corrida:

| Campo | Contrato exacto |
|---|---|
| `context` | `qa-windows/admission/<run_id>/<run_attempt>` |
| `state` | `success` |
| `creator.login` observado | `Gigisanta` |
| `description` | `<candidate installer SHA256 lowercase>:<expiresEpoch de 10 dígitos>` (75 caracteres) |
| `target_url` | `https://github.com/Gigisanta/simon-releases/actions/runs/<run_id>/attempts/<run_attempt>` |
| Frescura | edad no negativa y ≤10 s; expira entre ahora+30 s y created_at+45 s |

El owner conserva su **guard real** hasta estado terminal del run y comprueba
que no quede trabajo de backend antes de liberarlo. **El status no crea ni
prueba un lease y no concede exclusividad**; sólo es el handoff autenticado
de ese owner. La admisión por sí sola tampoco reemplaza un precheck fresco.
Si el issuer falla o su resultado es desconocido, no publica success ni
continúa el envío por otro camino.

El runner espera como máximo 10 minutos. Exige exactamente un status del
contexto, rechaza otro creador/run/attempt/hash, duplicados, expirados o fechas
futuras, y rechaza re-runs (`run_attempt` debe ser 1). Mediante su propia
operación persistente vuelve a comprobar rama/draft, health, consentimiento,
status y ART inmediatamente antes del único click. Verifica de nuevo frescura
en la interceptación del POST real para no gastar la vigencia esperando
actionability de la UI. No hay retries ni una segunda solicitud permitida.

El input es fijo, sintético y no sensible: una oración de ficción sobre una
cometa violeta de papel. El arnés valida que el POST nativo lleve exactamente
ese input y los ids de protocolo; deja salir una sola solicitud y exige HTTP
200, respuesta no vacía acorde al ejercicio y su texto exacto renderizado en
una nueva burbuja de la UI. El plazo total desde el click hasta render es
**30 s**. Al vencer desconecta ese cliente; el resultado queda incierto/fallido,
nunca PASS. El owner sigue siendo responsable de confirmar settlement del
backend antes de liberar recursos. No redispatch/reintento automático para
reparar una solicitud incierta.

### Operación local del owner de admisión

Sólo después del review, checks del integrador, configuración de environment
main-only, fixture y consentimiento normal ya autorizado, despachar manualmente
el modo full. El issuer **no despacha workflows ni genera automáticamente**.

En una **operación persistente ya admitida por el `resource_guard` canónico
`gpu-heavy`**, ejecutar desde este checkout público revisado:

```sh
node .github/scripts/windows-admit-owner.cjs \
  --run-id REVIEWED_RUN_ID \
  --release-id REVIEWED_RELEASE_ID \
  --asset-id REVIEWED_INSTALLER_ASSET_ID \
  --sha256 REVIEWED_64_LOWERCASE_HEX_SHA256 \
  --receipt /ABSOLUTE_PRIVATE_0700_DIRECTORY/NEW_RECEIPT.json
```

El directorio privado del recibo debe existir con modo `0700`; el archivo debe
ser **nuevo**, se crea `0600` y no se publica. No es un archivo de credenciales.
Reservar `--run-seconds 1800` en el guard canónico para el workflow de 25 min y
su settlement; **no ejecutar ese Node como comando suelto**, simular variables
ni copiar un hold ajeno para “admitirlo”. `MAAT_HOLD_OWNER` y `MAAT_HOLD_TOKEN`
deben ser los que posee ese mismo guard y corresponder al hold vivo de 8080.
No se transfiere el token ni una API key de inferencia a Actions.

El nombre público del owner y la presencia de una variable **no prueban**
ownership. Antes de admitir, el issuer autentica la capacidad contra el gateway
vivo con dos challenges locales a `/v1/chat/completions`, ambos con body JSON
`null`: un token deliberadamente distinto debe recibir
`403/invalid_gpu_hold_credentials`; el token propio debe llegar luego a
`400/invalid_json`. Esa combinación acredita el orden auth→validación del body.
No contiene modelo/prompt ni puede alcanzar resolución de modelo, cola, wake
o generación. Si el protocolo cambia o hay cualquier resultado desconocido,
se bloquea; nunca se adquiere, renueva, libera ni adopta un hold desde el issuer.
No se imprime ni persiste el token.

El último precheck también lee los archivos canónicos privados, sin overrides:
`var/bench-window.lock` debe estar ausente o válidamente vencido (cualquier
reserva activa, incluso homónima, bloquea); `var/ci-quiet.json` debe tener
actualización de como máximo 60 s, estado `off`, owner `null` y runners
`running|off`. Un archivo ilegible, symlink, permiso abierto, esquema desconocido,
estado futuro/stale o proceso `Runner.Worker` activo bloquea antes del status.
No pausa, drena, reactiva ni modifica runners/locks; debe esperar su turno real.

El issuer usa el `gh` local ya autorizado del owner, exige creator `Gigisanta`,
main/SHA revisados y el paso exacto en progreso. Espera como máximo 10 min y
vuelve a autenticar el lease y comprobar banco/CI quiet, health/stats,
maintenance/admisión/hold propio y ART dentro de `admitted-action.cjs`.
Antes del único POST de status persiste y sincroniza el
estado incierto en el recibo; un error o resultado desconocido **no se reintenta**.
Conserva la operación/guard hasta estado terminal del run de ese SHA y dos
snapshots quiet de settlement. Si no se puede demostrar settlement, no liberar
recursos ni redispatch: investigar bajo ese mismo owner.

### Evidencia y aceptación

Sólo el JSON allowlisted se publica en el **job summary**: SHA de workflow,
release/asset ids, hashes, clave pública Tauri, versiones, estado Authenticode,
NSIS exit code, startup/login/generation ms, sesión fixture verificada (sin id
de usuario/email), estado de perfil sin fecha, consentimiento existente, ACK y
conteos de historial restaurado, status id/context/tiempos y request id opaco
del servidor para correlación del owner.

No se suben logs nativos, screenshots, videos, traces, HAR, DOM, cookies,
tokens, cuerpos de login/chat ni directorios de perfil. Errores de herramientas
se convierten a códigos fijos; no se imprime el mensaje/stack de Playwright.
No se usan artifacts de Actions ni caches con estado autenticado.

Un job verde no es aprobación de release. El JSON declara
`releaseAcceptance=not-claimed` y `providerEvidence=owner-correlation-required`:
la UI prueba envío/respuesta/render reales, no demuestra por sí sola qué
proveedor/modelo ejecutó el backend. El owner correlaciona el request id con
evidencia de inferencia existente y su guard; no acepta una plantilla/fallback
como prueba de generación. Si falta esa correlación, la generación real sigue
**sin verificar**. Baseline/upgrade-login siempre dejan
`generation.state=not-requested`.

Criterios obligatorios para el owner:

- **Given** una VM hosted nueva y el baseline pinneado, **when** se instala y
  arranca, **then** registro, versión, firma updater y ventana nativa coinciden,
  con startup ≤30 s.
- **Given** el fixture exclusivo, **when** se envía el formulario de login nativo,
  **then** sesión `self` correcta y chat visible en ≤30 s, sin aceptar permisos.
- **Given** 0.1.9 instalado, **when** corre el NSIS del draft 0.1.12, **then**
  cambia la versión del mismo directorio y la UI nativa del candidato ingresa.
- **Given** consentimiento ausente/admisión inválida, **when** se pide full,
  **then** cero POSTs de chat salen y el motivo bloqueante es explícito.
- **Given** consentimiento normal previo, guard externo vigente y status fresco,
  **when** se hace el único click autorizado, **then** exactamente un POST
  sintético y respuesta renderizada ≤30 s; el owner aporta además inferencia
  correlacionada. Timeout/cualquier incertidumbre bloquea aceptación.
- Concurrencia/orden: group único sin cancelación, attempt=1, status de un uso,
  precheck+acción en una operación. No autoriza concurrencia con otro owner.
- Vacío/mínimos/errores: sin secretos, sin draft/firma/digest, selector ambiguo,
  health fallido, consentimiento desconocido y deadlines fallan cerrado.
- Límites de contenido/Unicode: input de ficción fijo en español, sin imágenes,
  archivos, datos de salud o casos adversariales clínicos; esos escenarios son
  N/A para este smoke, no cobertura de seguridad clínica.
- Compatibilidad: actualización manual sobre 0.1.9 con datos conservados;
  updater-offer e instalación automática son N/A, no se ejercitan aquí.
- Telemetría/cobros: el owner de cuenta verifica exclusión por marker actual de
  DB y consents opcionales apagados; el summary de UI no sustituye esa prueba.
  El POST anónimo no se atribuye a ese marker: exigir también la barrera previa
  a scripts observada en Windows real y correlación del owner, no sólo el hook
  escrito o un contador cero. `zeroFootprint=not-claimed` no desaparece.

La CI del PR define los checks Node de abajo. El integrador agrega `actionlint`
según el gate acordado; **ninguno se ejecutó localmente al preparar este cambio**:

```sh
for file in .github/scripts/*.cjs; do node --check "$file"; done
node --test .github/scripts/windows-contract.test.cjs .github/scripts/windows-cdp-guard.test.cjs .github/scripts/windows-admit-owner.test.cjs
actionlint .github/workflows/offline-checks.yml .github/workflows/windows-native-qa.yml
```

Agregar parse/análisis de `windows-install.ps1` en PowerShell y revisión
independiente de refs/environment/secrets antes de merge. Los tests Node son
regresiones offline de permisos/orden/admisión; no instalan ni generan y nunca
sustituyen el primer run Windows real. Reportar **Pass / Fail / Blocked** con
evidencia de esa corrida y mantener separados bootstrap, instalación, UI,
inferencia y aceptación final.
