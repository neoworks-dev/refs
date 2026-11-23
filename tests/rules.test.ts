// What the rules are for: never pressing what changes something, recognising addresses that are
// the same page, and keeping personal data out of the forms the model fills.
import { describe, expect, test } from 'bun:test';
import {
	isDestructive,
	isPersonalDataField,
	isThirdPartyLogin,
	looksLikePersonalData,
	typedFieldRefusal,
	typedTextRefusal,
	normalizeUrl,
	urlKey
} from '../crawler/rules.ts';

describe('destructive controls', () => {
	test('names that destroy data or commit to something are never clicked', () => {
		for (const label of [
			'Delete account',
			'Sign out',
			'Log out',
			'Buy now',
			'Place order',
			'Confirm'
		]) {
			expect(isDestructive(label)).toBe(true);
		}
	});

	test('ordinary menu triggers are fine', () => {
		for (const label of ['Products', 'Resources', 'Pricing', 'Menu', 'Learn more']) {
			expect(isDestructive(label)).toBe(false);
		}
	});
});

describe('url identity', () => {
	test('tracking parameters, hashes and trailing slashes do not make a new page', () => {
		const first = normalizeUrl('https://www.example.com/pricing/?utm_source=x#plans');
		const second = normalizeUrl('https://example.com/pricing');

		expect(urlKey(first!)).toBe(urlKey(second!));
	});
});

describe('personal data fields', () => {
	const field = (type: string, text = '', autocomplete = '') => ({ type, text, autocomplete });

	test('email, password and phone fields are personal whatever they are called', () => {
		expect(isPersonalDataField(field('email'))).toBe(true);
		expect(isPersonalDataField(field('password', 'secret'))).toBe(true);
		expect(isPersonalDataField(field('tel'))).toBe(true);
	});

	test('a plain text field is personal when its autocomplete or its words say so', () => {
		expect(isPersonalDataField(field('text', '', 'given-name'))).toBe(true);
		expect(isPersonalDataField(field('text', '', 'section-billing cc-number'))).toBe(true);
		expect(isPersonalDataField(field('text', 'Your work email'))).toBe(true);
		expect(isPersonalDataField(field('text', 'first_name'))).toBe(true);
		expect(isPersonalDataField(field('text', 'Street and house number'))).toBe(true);
		expect(isPersonalDataField(field('textarea', 'Card number'))).toBe(true);
	});

	test('search and filter fields are allowed even when they mention a name', () => {
		expect(isPersonalDataField(field('search'))).toBe(false);
		expect(isPersonalDataField(field('text', 'Search by name'))).toBe(false);
		expect(isPersonalDataField(field('text', 'Filter integrations'))).toBe(false);
		expect(isPersonalDataField(field('text', 'Find a template'))).toBe(false);
	});

	test('a message box is not personal data', () => {
		expect(isPersonalDataField(field('textarea', 'How can we help?'))).toBe(false);
	});

	test('an email address or phone number is personal data wherever it is typed', () => {
		expect(looksLikePersonalData('john@example.com')).toBe(true);
		expect(looksLikePersonalData('+49 170 1234567')).toBe(true);
		expect(looksLikePersonalData('dark mode')).toBe(false);
		expect(looksLikePersonalData('2024 pricing')).toBe(false);
	});
});

describe('the demo identity', () => {
	const identity = {
		email: 'demo+acme@gmail.com',
		password: 'Xy7!pQ2$mN9&wLk4Rt8*',
		name: 'Alex Morgan'
	};
	const field = (type: string, text = '', autocomplete = '') => ({ type, text, autocomplete });

	test('the account email, password and a made-up name may be typed, other personal data may not', () => {
		expect(typedTextRefusal(identity.email, identity)).toBeUndefined();
		expect(typedTextRefusal(identity.password, identity)).toBeUndefined();
		expect(typedTextRefusal('Alex Morgan', identity)).toBeUndefined();
		expect(typedTextRefusal('john@example.com', identity)).toContain('personal data');
		expect(typedTextRefusal('+49 170 1234567', identity)).toContain('personal data');
		// Without an account nothing personal is typed, not even the same address.
		expect(typedTextRefusal(identity.email, undefined)).toContain('personal data');
	});

	test('email, name and company fields take the demo identity', () => {
		expect(typedFieldRefusal(field('email'), identity.email, identity)).toBeUndefined();
		expect(
			typedFieldRefusal(field('text', 'Full name', 'name'), 'Alex Morgan', identity)
		).toBeUndefined();
		expect(
			typedFieldRefusal(field('text', 'Company', 'organization'), 'Morgan Labs', identity)
		).toBeUndefined();
		expect(
			typedFieldRefusal(field('text', 'Work e-mail address'), identity.email, identity)
		).toBeUndefined();
	});

	test('the password goes into password fields only, and only the demo one', () => {
		expect(
			typedFieldRefusal(field('password', 'Password'), identity.password, identity)
		).toBeUndefined();
		expect(
			typedFieldRefusal(
				field('text', 'Confirm password', 'new-password'),
				identity.password,
				identity
			)
		).toBeUndefined();
		expect(typedFieldRefusal(field('password', 'Password'), 'hunter2', identity)).toContain('demo');
		expect(typedFieldRefusal(field('textarea', 'Message'), identity.password, identity)).toContain(
			'password'
		);
	});

	test('payment, phone and postal fields stay refused', () => {
		expect(typedFieldRefusal(field('tel', 'Phone'), '12345', identity)).toContain('payment, phone');
		expect(
			typedFieldRefusal(field('text', 'Card number', 'cc-number'), '4242', identity)
		).toContain('payment, phone');
		expect(typedFieldRefusal(field('text', 'Street address'), 'Main St 1', identity)).toContain(
			'payment, phone'
		);
		expect(typedFieldRefusal(field('text', 'Mobile number'), '1', identity)).toContain(
			'payment, phone'
		);
		expect(typedFieldRefusal(field('text', 'Date of birth', 'bday'), '1990', identity)).toContain(
			'payment, phone'
		);
	});

	test('search fields are fine either way', () => {
		expect(
			typedFieldRefusal(field('search', 'Search by card'), 'pricing', identity)
		).toBeUndefined();
		expect(
			typedFieldRefusal(field('text', 'Find a template'), 'pricing', undefined)
		).toBeUndefined();
	});

	test('without an account every personal field is refused as before', () => {
		expect(typedFieldRefusal(field('email'), 'x', undefined)).toContain('personal data');
		expect(typedFieldRefusal(field('password'), 'x', undefined)).toContain('personal data');
	});

	test('submitting and confirming are allowed with an account, paying never is', () => {
		const account = { hasDemoAccount: true };
		expect(isDestructive('Submit')).toBe(true);
		expect(isDestructive('Confirm password')).toBe(true);
		expect(isDestructive('Submit', account)).toBe(false);
		expect(isDestructive('Confirm password', account)).toBe(false);
		expect(isDestructive('Pay now', account)).toBe(true);
		expect(isDestructive('Delete account', account)).toBe(true);
		expect(isDestructive('Log out', account)).toBe(true);
	});

	test('logging in through another service is not what the demo account does', () => {
		expect(isThirdPartyLogin('Continue with Google')).toBe(true);
		expect(isThirdPartyLogin('Sign in with GitHub')).toBe(true);
		expect(isThirdPartyLogin('Log in with SSO')).toBe(true);
		expect(isThirdPartyLogin('Continue with email')).toBe(false);
		expect(isThirdPartyLogin('Create account')).toBe(false);
	});
});
