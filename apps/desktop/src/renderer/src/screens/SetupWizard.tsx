import type { LicenseStatus, ShopProfile } from '@nexodesk/shared';
import { MIN_USER_PASSWORD, USERNAME_PATTERN } from '@nexodesk/shared';
import { useCallback, useEffect, useState } from 'react';
import { BackupIcon, DeviceIcon, RestoreIcon } from '../components/icons';
import { useToast } from '../components/toast';
import { Banner, Button, Field, Panel } from '../components/ui';
import { call, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BackupSetupPanel } from './BackupScreen';
import { LicenseScreen } from './LicenseScreen';
import { RestoreScreen } from './RestoreScreen';
import { EMPTY_SHOP, ShopFields } from './ShopScreen';

type Step = 'welcome' | 'restore' | 'shop' | 'owner' | 'backup' | 'license';
const NEW_SHOP_STEPS: Step[] = ['shop', 'owner', 'backup', 'license'];

function Progress({ step }: { step: Step }) {
  const index = NEW_SHOP_STEPS.indexOf(step);
  if (index < 0) return null;
  return (
    <div className="cd-wizard__progress" aria-label={`Step ${index + 1} of ${NEW_SHOP_STEPS.length}`}>
      {NEW_SHOP_STEPS.map((name, position) => (
        <span key={name} className={`cd-wizard__dot ${position <= index ? 'cd-wizard__dot--done' : ''}`} />
      ))}
    </div>
  );
}

/**
 * First run on a new computer: set up a new shop, or bring an existing shop's
 * data over from a backup. After the owner account exists, backup and licence
 * can be set up here or skipped and done later.
 */
export function SetupWizard({ onFinished }: { onFinished: () => void }) {
  const notify = useToast();
  const { signedIn, user } = useAuth();
  const [step, setStep] = useState<Step>(user ? 'backup' : 'welcome');
  const [shop, setShop] = useState<ShopProfile>(EMPTY_SHOP);
  const [owner, setOwner] = useState({ fullName: '', username: '', password: '', confirm: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const [license, setLicense] = useState<LicenseStatus | null>(null);

  const loadLicense = useCallback(() => {
    void call('license:status').then(setLicense).catch(() => setLicense(null));
  }, []);
  useEffect(() => {
    if (step === 'license') loadLicense();
  }, [step, loadLicense]);

  const usernameValid = USERNAME_PATTERN.test(owner.username.trim().toLowerCase());
  const pinValid = owner.pin === '' || /^\d{4,6}$/.test(owner.pin);
  const ownerReady =
    owner.fullName.trim() !== '' && usernameValid && owner.password.length >= MIN_USER_PASSWORD && owner.password === owner.confirm && pinValid;

  async function createShop() {
    setBusy(true);
    try {
      const created = await call('setup:createShop', {
        shop: { ...shop, ownerName: shop.ownerName || owner.fullName },
        owner: {
          fullName: owner.fullName,
          username: owner.username,
          password: owner.password,
          ...(owner.pin ? { pin: owner.pin } : {}),
        },
      });
      signedIn(created);
      setOwner({ fullName: '', username: '', password: '', confirm: '', pin: '' });
      setStep('backup');
    } catch (error) {
      notify({ tone: 'danger', title: 'Setup not saved', message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cd-auth" style={{ alignItems: 'start' }}>
      <div className="cd-wizard">
        <div className="cd-auth__brand">
          <span className="cd-brand__mark">
            <DeviceIcon />
          </span>
          <div>
            <div className="cd-auth__title">Welcome to NexoDesk</div>
            <div className="cd-brand__by">Shop management by NexoERP</div>
          </div>
        </div>
        <Progress step={step} />

        {step === 'welcome' ? (
          <div className="cd-form-grid">
            <button type="button" className="cd-choice" onClick={() => setStep('shop')}>
              <DeviceIcon />
              <span className="cd-panel__title">Set up a new shop</span>
              <span className="cd-panel__description">Start with empty data: shop details, owner account, backups and licence.</span>
            </button>
            <button type="button" className="cd-choice" onClick={() => setStep('restore')}>
              <RestoreIcon />
              <span className="cd-panel__title">Restore from a backup</span>
              <span className="cd-panel__description">Moving to a new computer? Bring all shop data, users and settings from a .ndbak backup.</span>
            </button>
          </div>
        ) : null}

        {step === 'restore' ? (
          <>
            <div>
              <Button variant="ghost" onClick={() => setStep('welcome')}>← Back</Button>
            </div>
            <RestoreScreen />
          </>
        ) : null}

        {step === 'shop' ? (
          <Panel
            title="Shop details"
            description="You can change these later in Settings."
            actions={
              <>
                <Button variant="ghost" onClick={() => setStep('welcome')}>Back</Button>
                <Button variant="primary" disabled={!shop.shopName.trim()} onClick={() => setStep('owner')}>Continue</Button>
              </>
            }
          >
            <div style={{ padding: 'var(--space-3) 0' }}>
              <ShopFields value={shop} onChange={setShop} />
            </div>
          </Panel>
        ) : null}

        {step === 'owner' ? (
          <Panel
            title="Owner account"
            description="The owner can do everything, including adding staff, restoring backups and renewing the licence."
            actions={
              <>
                <Button variant="ghost" onClick={() => setStep('shop')}>Back</Button>
                <Button variant="primary" busy={busy} disabled={!ownerReady} onClick={() => void createShop()}>Create shop</Button>
              </>
            }
          >
            <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
              <div className="cd-form-grid">
                <Field label="Full name">
                  {(id) => <input id={id} className="cd-input" value={owner.fullName} onChange={(event) => setOwner({ ...owner, fullName: event.target.value })} />}
                </Field>
                <Field label="Username" hint="Small letters and numbers, for example usman" error={owner.username && !usernameValid ? 'Use 3 to 32 letters, numbers, dots, dashes or underscores.' : null}>
                  {(id) => <input id={id} className="cd-input" autoComplete="username" value={owner.username} onChange={(event) => setOwner({ ...owner, username: event.target.value.toLowerCase() })} />}
                </Field>
                <Field label="Password" hint={`At least ${MIN_USER_PASSWORD} characters`}>
                  {(id) => <input id={id} className="cd-input" type="password" autoComplete="new-password" value={owner.password} onChange={(event) => setOwner({ ...owner, password: event.target.value })} />}
                </Field>
                <Field label="Confirm password" error={owner.confirm && owner.confirm !== owner.password ? 'The passwords do not match.' : null}>
                  {(id) => <input id={id} className="cd-input" type="password" autoComplete="new-password" value={owner.confirm} onChange={(event) => setOwner({ ...owner, confirm: event.target.value })} />}
                </Field>
                <Field label="Quick PIN (optional)" hint="4 to 6 digits for fast sign-in at the counter" error={!pinValid ? 'A PIN has 4 to 6 digits.' : null}>
                  {(id) => <input id={id} className="cd-input" inputMode="numeric" maxLength={6} value={owner.pin} onChange={(event) => setOwner({ ...owner, pin: event.target.value.replace(/\D/g, '') })} />}
                </Field>
              </div>
            </div>
          </Panel>
        ) : null}

        {step === 'backup' ? (
          <>
            <BackupSetupPanel onDone={() => setStep('license')} />
            <div className="cd-actions">
              <Button variant="ghost" icon={<BackupIcon />} onClick={() => setStep('license')}>Skip, set up backups later</Button>
            </div>
          </>
        ) : null}

        {step === 'license' ? (
          <>
            <LicenseScreen status={license} onChanged={loadLicense} />
            <div className="cd-actions">
              <Button variant="primary" onClick={onFinished}>
                {license?.canWrite ? 'Finish' : 'Activate later and finish'}
              </Button>
            </div>
            {!license?.canWrite ? (
              <Banner tone="info" title="Activation can be done any time">
                Until NexoDesk is activated, backups and restore work, but new sales cannot be recorded.
              </Banner>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
