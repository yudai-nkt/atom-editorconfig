/** @babel */
import generateConfig from './commands/generate';

const lazyReq = require('lazy-req')(require);

const statusTile = lazyReq('./lib/statustile-view');
const editorconfig = lazyReq('editorconfig');

const STATES = ['subtle', 'success', 'info', 'warning', 'error'];

// Holds all **blacklisted** packages and the properties we assume are affected by them
// 'packagename': [properties]
const BLACKLISTED_PACKAGES = {
	whitespace: ['insert_final_newline', 'trim_trailing_whitespace']
};

// Sets the state of the embedded editorconfig
// This includes the severity (info, warning..) as well as the notification-messages for users
function setState(ecfg) {
	const messages = [];
	let statcon = 0;

	// Check if any editorconfig-setting is in use
	if (Object.keys(ecfg.settings).reduce((prev, curr) => {
		return ecfg.settings[curr] !== 'auto' || prev;
	}, false)) {
		statcon = Math.max(statcon, 1);
	}

	// Check the 'Tab Type'-setting
	if (ecfg.settings.indent_style !== 'auto' &&
		atom.config.get('editor.tabType') !== 'auto') {
		const tabType = atom.config.get('editor.tabType');

		messages.push(`**Tab Type:** You editor's configuration setting "Tab Type"
		(currently "${tabType}" prevents the editorconfig-property \`indent_style\` from working.
		@"Tab Type" **must** be set to "auto" to fix this issue.`);

		statcon = Math.max(statcon, 4);
	}

	// Check for BLACKLISTED packages
	const suspiciuousPackages = {};
	let affectedProperties;
	for (const packageName in BLACKLISTED_PACKAGES) {
		if ({}.hasOwnProperty.call(BLACKLISTED_PACKAGES, packageName)) {
			affectedProperties = BLACKLISTED_PACKAGES[packageName].filter(prop => {
				return ecfg.settings[prop] !== 'auto';
			});
			if (affectedProperties.length > 0 &&
				atom.packages.isPackageActive(packageName)) {
				suspiciuousPackages[packageName] = affectedProperties;
			}
		}
	}
	if (Object.keys(suspiciuousPackages).length > 0) {
		for (const packageName in suspiciuousPackages) {
			if ({}.hasOwnProperty.call(suspiciuousPackages, packageName)) {
				const properties = suspiciuousPackages[packageName];
				messages.push(`**${packageName}:** It is likely that the
				${packageName}-package prevents the following
				propert${properties.length > 1 ? 'ies' : 'y'} from working reliably:
				\`${properties.join('`, `')}\`.@You may deactivate or disable the ${packageName}-package
				to fix that issue.`);
			}
		}
		statcon = Math.max(statcon, 3);
	}

	switch (statcon) {
		case 1:
			messages.push(`The editorconfig was applied successfully and the editor for this file
			should work as expected. If you face any unexpected behavior please report us the issue.
			♥️`);
			break;
		case 0:
			messages.push(`For this file were no editorconfig-settings applied.`);
			break;
		default:
			break;
	}

	// Apply changes
	ecfg.messages = messages;
	ecfg.state = STATES[statcon];
	statusTile().update(ecfg.state);
}

// Reapplies the whole editorconfig to **all** open TextEditor-instances
function reapplyEditorconfig() {
	const textEditors = atom.workspace.getTextEditors();
	for (const index in textEditors) { // eslint-disable-line guard-for-in
		observeTextEditor(textEditors[index]);
	}
}

// Reapplies the settings immediately after changing the focus to a new pane
function observeActivePaneItem(editor) {
	if (editor && editor.constructor.name === 'TextEditor') {
		if (editor.getBuffer().editorconfig) {
			editor.getBuffer().editorconfig.applySettings();
		}
	} else {
		statusTile().update('subtle');
	}
}

// Initializes the (into the TextBuffer-instance) embedded editorconfig-object
function initializeTextBuffer(buffer) {
	if ('editorconfig' in buffer === false) {
		buffer.editorconfig = {
			buffer, // preserving a reference to the parent TextBuffer
			state: 'subtle',
			settings: {
				trim_trailing_whitespace: 'auto', // eslint-disable-line camelcase
				insert_final_newline: 'auto', // eslint-disable-line camelcase
				end_of_line: 'auto', // eslint-disable-line camelcase
				indent_style: 'auto', // eslint-disable-line camelcase
				tab_width: 'auto', // eslint-disable-line camelcase
				charset: 'auto' // eslint-disable-line camelcase
			},

			// Applies the settings to the buffer and the corresponding editor
			applySettings() {
				const editor = atom.workspace.getActiveTextEditor();
				const settings = this.settings;

				if (editor && editor.getBuffer() === buffer) {
					if (settings.indent_style !== 'auto') {
						editor.setSoftTabs(settings.indent_style === 'space');
					}
					if (settings.tab_width !== 'auto') {
						editor.setTabLength(settings.tab_width);
					}
					if (settings.end_of_line !== 'auto') {
						buffer.setPreferredLineEnding(settings.end_of_line);
					}
					if (settings.charset !== 'auto') {
						buffer.setEncoding(settings.charset);
					}
				}
				setState(this);
			},

			// onWillSave-Event-Handler
			// Trims whitespaces and inserts/strips final newline before saving
			onWillSave() {
				const settings = this.settings;

				if (settings.trim_trailing_whitespace === true) {
					// eslint-disable-next-line max-params
					buffer.backwardsScan(/[ \t]+$/m, params => {
						if (params.match[0].length > 0) {
							params.replace('');
						}
					});
				}

				if (settings.insert_final_newline !== 'auto') {
					const lastRow = buffer.getLineCount() - 1;

					if (buffer.isRowBlank(lastRow)) {
						const previousNonBlankRow = buffer.previousNonBlankRow(lastRow);

						// Strip empty lines from the end
						if (previousNonBlankRow < lastRow) {
							buffer.deleteRows(previousNonBlankRow + 1, lastRow);
						}
					}
					if (settings.insert_final_newline === true) {
						buffer.append('\n');
					}
				}
			}
		};

		buffer.onWillSave(buffer.editorconfig.onWillSave.bind(buffer.editorconfig));
		if (buffer.getUri() && buffer.getUri().match(/[\\|\/]\.editorconfig$/g) !== null) {
			buffer.onDidSave(reapplyEditorconfig);
		}
	}
}

// Reveal and apply the editorconfig for the given TextEditor-instance
function observeTextEditor(editor) {
	if (!editor) {
		return;
	}
	initializeTextBuffer(editor.getBuffer());

	const file = editor.getURI();
	if (!file) {
		editor.onDidSave(() => {
			observeTextEditor(editor);
		});
		return;
	}

	editorconfig().parse(file).then(config => {
		if (Object.keys(config).length === 0) {
			return;
		}

		const ecfg = editor.getBuffer().editorconfig;
		const settings = ecfg.settings;
		const lineEndings = {
			crlf: '\r\n',
			cr: '\r',
			lf: '\n'
		};

		// Preserve evaluated Editorconfig
		ecfg.config = config;

		// Carefully normalize and initialize config-settings
		// eslint-disable-next-line camelcase
		settings.trim_trailing_whitespace = ('trim_trailing_whitespace' in config) &&
			typeof config.trim_trailing_whitespace === 'boolean' ?
			config.trim_trailing_whitespace === true :
			'auto';

		// eslint-disable-next-line camelcase
		settings.insert_final_newline = ('insert_final_newline' in config) &&
			typeof config.insert_final_newline === 'boolean' ?
			config.insert_final_newline === true :
			'auto';

		// eslint-disable-next-line camelcase
		settings.indent_style = (('indent_style' in config) &&
			config.indent_style.search(/^(space|tab)$/) > -1) ?
			config.indent_style :
			'auto';

		// eslint-disable-next-line camelcase
		settings.end_of_line = lineEndings[config.end_of_line] || 'auto';

		// eslint-disable-next-line camelcase
		settings.tab_width = parseInt(config.indent_size || config.tab_width, 10);
		if (isNaN(settings.tab_width)) {
			settings.tab_width = 'auto'; // eslint-disable-line camelcase
		}

		settings.charset = ('charset' in config) ?
			config.charset.replace(/-/g, '').toLowerCase() :
			'auto';

		// Apply initially
		ecfg.applySettings();
	}).catch(Error, e => {
		console.warn(`atom-editorconfig: ${e}`);
	});
}

// Hook into the events to recognize the user opening new editors or changing the pane
const activate = () => {
	generateConfig();
	atom.workspace.observeTextEditors(observeTextEditor);
	atom.workspace.observeActivePaneItem(observeActivePaneItem);
};

// Apply the statusbar icon
const consumeStatusBar = statusBar => {
	statusBar.addRightTile({
		item: statusTile().create(),
		priority: 999
	});
};

export default {activate, consumeStatusBar};
