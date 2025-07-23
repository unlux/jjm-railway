import {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityProviderService,
  GoogleAuthProviderOptions,
  Logger,
} from "@medusajs/framework/types";
import {
  AbstractAuthModuleProvider,
  MedusaError,
} from "@medusajs/framework/utils";
import jwt, { JwtPayload } from "jsonwebtoken";
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows";
import { container } from "@medusajs/framework";
import { setAuthAppMetadataWorkflow } from "../../workflows/auth-custom-google/workflows";

type InjectedDependencies = {
  logger: Logger;
};

interface LocalServiceConfig extends GoogleAuthProviderOptions {}

class AuthCustomGoogleProviderService extends AbstractAuthModuleProvider {
  static identifier = "custom-google";
  static DISPLAY_NAME = "Google Customized Authentication";

  protected config_: LocalServiceConfig;
  protected logger_: Logger;

  static validateOptions(options: GoogleAuthProviderOptions) {
    if (!options.clientId) {
      throw new Error("Google clientId is required");
    }

    if (!options.clientSecret) {
      throw new Error("Google clientSecret is required");
    }

    if (!options.callbackUrl) {
      throw new Error("Google callbackUrl is required");
    }
  }

  constructor(
    { logger }: InjectedDependencies,
    options: GoogleAuthProviderOptions
  ) {
    // @ts-ignore
    super(...arguments);
    this.config_ = options;
    this.logger_ = logger;
  }

  async register(_): Promise<AuthenticationResponse> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Custom Google Auth does not support registration."
    );
  }

  async authenticate(
    data: AuthenticationInput,
    authIdentityProviderService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Custom Google Auth does not support authentication."
    );
  }

  async validateCallback(
    req: AuthenticationInput,
    authIdentityService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    const query: Record<string, string> = req.query ?? {};
    const body: Record<string, string> = req.body ?? {};

    if (query.error) {
      return {
        success: false,
        error: `${query.error_description}, read more at: ${query.error_uri}`,
      };
    }

    const code = query?.code ?? body?.code;
    if (!code) {
      return { success: false, error: "No code provided" };
    }

    const state = await authIdentityService.getState(query?.state as string);
    if (!state) {
      return { success: false, error: "No state provided, or session expired" };
    }

    const params = `client_id=${this.config_.clientId}&client_secret=${this.config_.clientSecret}&code=${code}&redirect_uri=${state.callback_url}&grant_type=authorization_code`;
    const exchangeTokenUrl = new URL(
      `https://oauth2.googleapis.com/token?${params}`
    );

    try {
      const response = await fetch(exchangeTokenUrl.toString(), {
        method: "POST",
      }).then((r) => {
        if (!r.ok) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Could not exchange token, ${r.status}, ${r.statusText}`
          );
        }

        return r.json();
      });

      const { authIdentity, success } = await this._verify(
        response.id_token as string,
        authIdentityService
      );

      return {
        success,
        authIdentity,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _verify(
    idToken: string | undefined,
    authIdentityService: AuthIdentityProviderService
  ) {
    if (!idToken) {
      return { success: false, error: "No ID found" };
    }

    const jwtData = jwt.decode(idToken, {
      complete: true,
    }) as JwtPayload;
    const payload = jwtData.payload;

    if (!payload.email_verified) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Email not verified, cannot proceed with authentication"
      );
    }

    const entity_id = payload.sub;
    const userMetadata = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      given_name: payload.given_name,
      family_name: payload.family_name,
    };

    let authIdentity;

    try {
      authIdentity = await authIdentityService.retrieve({
        entity_id,
      });
    } catch (error) {
      if (error.type === MedusaError.Types.NOT_FOUND) {
        const createdAuthIdentity = await authIdentityService.create({
          entity_id,
          user_metadata: userMetadata,
        });
        await createCustomerAccountWorkflow(container).run({
          input: {
            authIdentityId: createdAuthIdentity.id,
            customerData: {
              first_name: userMetadata.given_name,
              last_name: userMetadata.family_name,
              email: userMetadata.email,
            },
          },
        });
        authIdentity = await authIdentityService.retrieve({
          entity_id,
        });
      } else {
        return { success: false, error: error.message };
      }
    }

    return {
      success: true,
      authIdentity,
    };
  }
}

export default AuthCustomGoogleProviderService;
