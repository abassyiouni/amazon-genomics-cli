package sts

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/sts"
)

func (client Client) GetAccount() (string, error) {
	output, err := client.sts.GetCallerIdentity(context.Background(), &sts.GetCallerIdentityInput{})
	if err != nil {
		return "", err
	}
	if output.Account == nil || *output.Account == "" {
		return "", fmt.Errorf("unable to determine account ID")
	}
	return *output.Account, nil
}
