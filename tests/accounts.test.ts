// The demo account: the addresses and passwords it is given, and reading the mail a sign-up causes.
import { describe, expect, test } from 'bun:test';
import { simpleParser } from 'mailparser';
import { generatePassword, nextAccountTag, pageAsksForVerification } from '../crawler/accounts.ts';
import { findVerification, isAddressedTo, plusAddress } from '../crawler/mail.ts';

describe('plus addresses', () => {
	test('a site gets its own address in the demo inbox', () => {
		expect(plusAddress('demo@gmail.com', 'linear-app')).toBe('demo+linear-app@gmail.com');
	});

	test('a refused address is followed by a numbered one, never reused', () => {
		const first = plusAddress('demo@gmail.com', nextAccountTag('linear-app', undefined));
		const second = plusAddress('demo@gmail.com', nextAccountTag('linear-app', first));
		const third = plusAddress('demo@gmail.com', nextAccountTag('linear-app', second));

		expect(first).toBe('demo+linear-app@gmail.com');
		expect(second).toBe('demo+linear-app-2@gmail.com');
		expect(third).toBe('demo+linear-app-3@gmail.com');
	});
});

describe('passwords', () => {
	test('they are long and pass common rules for character classes', () => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const password = generatePassword();
			expect(password.length).toBeGreaterThanOrEqual(16);
			expect(password).toMatch(/[a-z]/);
			expect(password).toMatch(/[A-Z]/);
			expect(password).toMatch(/\d/);
			expect(password).toMatch(/[^A-Za-z0-9]/);
		}
	});

	test('two accounts never share one', () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});
});

describe('pages that wait for an email', () => {
	test('they say so in the usual words', () => {
		expect(pageAsksForVerification('Check your inbox. We sent a link to a@b.com')).toBe(true);
		expect(pageAsksForVerification('Enter the 6-digit code we sent you')).toBe(true);
		expect(pageAsksForVerification('Verify your email address to continue')).toBe(true);
		expect(pageAsksForVerification('Pricing. Compare plans. Start for free')).toBe(false);
	});
});

describe('verification mails', () => {
	test('a link that says verify wins over the footer links', () => {
		const found = findVerification({
			subject: 'Welcome to Acme',
			html: `<a href="https://acme.com/blog">Our blog</a>
				<a href="https://acme.com/auth/confirm?token=abc&amp;x=1">Verify your email</a>
				<a href="https://acme.com/unsubscribe?u=1">Unsubscribe</a>`,
			text: ''
		});

		expect(found?.link).toBe('https://acme.com/auth/confirm?token=abc&x=1');
	});

	test('a link is found by its address when the button says only "Continue"', () => {
		const found = findVerification({
			subject: 'Your login link',
			html: '<a href="https://acme.com/magic-link/xyz">Continue</a>',
			text: ''
		});

		expect(found?.link).toBe('https://acme.com/magic-link/xyz');
	});

	test('a code is found in the subject, after the word code, or alone on a line', () => {
		expect(
			findVerification({ subject: '482913 is your Acme verification code', html: '', text: '' })
				?.code
		).toBe('482913');
		expect(
			findVerification({
				subject: 'Sign in',
				html: '',
				text: 'Your code: 771204\nIt expires soon.'
			})?.code
		).toBe('771204');
		expect(
			findVerification({
				subject: 'Confirm your email',
				html: '',
				text: 'Hello,\n\n 559031 \n\nBye'
			})?.code
		).toBe('559031');
	});

	test('a newsletter that happens to have links is not a verification mail', () => {
		const found = findVerification({
			subject: '3 new posts this week',
			html: '<a href="https://acme.com/blog/post-1">Read more</a>',
			text: ''
		});

		expect(found).toBeUndefined();
	});
});

describe('mail to the right address', () => {
	async function mailTo(recipient: string) {
		return simpleParser(
			`From: noreply@acme.com\r\nTo: ${recipient}\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello`
		);
	}

	test('only the exact plus address counts, not another site or an attempt with a suffix', async () => {
		const address = 'demo+linear-app@gmail.com';

		expect(isAddressedTo(await mailTo(address), address)).toBe(true);
		expect(isAddressedTo(await mailTo('Demo <DEMO+Linear-App@gmail.com>'), address)).toBe(true);
		expect(isAddressedTo(await mailTo('demo+linear-app-2@gmail.com'), address)).toBe(false);
		expect(isAddressedTo(await mailTo('demo+resend-com@gmail.com'), address)).toBe(false);
		expect(isAddressedTo(await mailTo('demo@gmail.com'), address)).toBe(false);
	});
});
